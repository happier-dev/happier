import { createHash } from 'node:crypto';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { ProjectCommandFileFactV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';

/**
 * The host's contained checkout reader. `readBytes` refuses paths that leave the checkout
 * (`outside_root`), including through links; `realpath`/`stat` read the same source.
 */
export type LiteralCommandFileIo = Readonly<{
    readBytes(root: string, file: string): Promise<Readonly<{ kind: 'read'; bytes: Uint8Array } | { kind: 'absent' } | { kind: 'refused'; code: string }>>;
    realpath(path: string): Promise<string>;
    stat(path: string): Promise<Readonly<{ isDirectory(): boolean }>>;
}>;

type Family = Readonly<{
    /** After one of these the program runs inline code or a module, not a script file. */
    inline: readonly string[];
    /** Flags whose next word is their value. */
    valued?: readonly string[];
    /** Flags whose next word is the script file. */
    script?: readonly string[];
    /** One subcommand word before the script (`deno run x.ts`). */
    subcommand?: string;
    /** PowerShell flags are case-insensitive. */
    caseInsensitive?: boolean;
    /** A folder operand loads its package.json `main` (default index.js). */
    packageEntry?: true;
}>;

const SHELL: Family = { inline: ['-c'], valued: ['-o', '+o', '-O', '+O'] };
const NODE: Family = { packageEntry: true, inline: ['-e', '-p', '--eval', '--print'], valued: ['-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions', '--max-old-space-size', '--stack-size', '--inspect-port', '--title'] };
const FAMILIES: Readonly<Record<string, Family>> = {
    sh: SHELL, bash: SHELL, zsh: SHELL, dash: SHELL, ksh: SHELL, fish: SHELL,
    source: { inline: [] }, '.': { inline: [] },
    node: NODE, tsx: { ...NODE, subcommand: 'watch' },
    deno: { ...NODE, subcommand: 'run' }, bun: { ...NODE, subcommand: 'run' },
    python: { inline: ['-c', '-m'], valued: ['-W', '-X'] },
    ruby: { inline: ['-e'], valued: ['-r', '-I', '-C'] },
    perl: { inline: ['-e', '-E'] },
    php: { inline: ['-r'], valued: ['-d', '-c'], script: ['-f'] },
    pwsh: { inline: ['-command', '-c', '-encodedcommand', '-ec', '-e'], script: ['-file', '-f'], caseInsensitive: true,
        valued: ['-executionpolicy', '-ep', '-configurationname', '-workingdirectory', '-wd', '-windowstyle', '-outputformat', '-of', '-inputformat', '-if', '-settingsfile', '-custompipename', '-version', '-v'] },
};
const WRAPPERS = new Set(['env', 'sudo', 'exec', 'command', 'time', 'nohup', 'call']);
const SUDO_VALUED = new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U']);
const TOKEN = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;

function familyOf(program: string): Family | undefined {
    const name = basename(program.replaceAll('\\', '/')).toLowerCase().replace(/\.exe$/, '');
    if (/^python\d*(?:\.\d+)*$/.test(name)) return FAMILIES.python;
    return FAMILIES[name === 'powershell' ? 'pwsh' : name];
}

/**
 * Checkout-relative files a literal command line runs directly: each command segment's
 * path-like program (or bare Windows `.cmd`/`.bat`/`.ps1`, which cmd resolves from the
 * cwd) and an interpreter's script operand, after wrapper words such as `env`, `sudo`
 * and `cmd /c`. This is a lexical scan, not a shell parser: nested `-c` code, command
 * substitution, and files a script sources or reads are declared through
 * `workspace.setupInputs`; `npm run`/`make`/`just` use the native source kinds. Paths
 * outside the checkout are omitted; the command text already names them.
 */
export function listLiteralCommandExecutedFiles(root: string, cwd: string, command: string): string[] {
    return [...scanLiteralCommand(root, cwd, command).files];
}

/** One command string, or separate lines (a package script, a recipe line) that each start in `cwd` or their own. */
export type LiteralCommandLines = string | readonly (string | Readonly<{ command: string; cwd: string }>)[];

function scanLiteralCommand(root: string, cwd: string, command: LiteralCommandLines) {
    const files = new Set<string>();
    const packageOperands = new Set<string>();
    const within = (path: string) => {
        const local = relative(root, path);
        return local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local) ? local : undefined;
    };
    let segmentCwd = cwd;
    // Home (`~`) is outside the checkout.
    const add = (token: string) => {
        const local = token.startsWith('~') ? undefined : within(resolve(segmentCwd, token));
        if (local === undefined) return undefined;
        // The checkout root itself (`node .`) is the folder `.`.
        const file = local === '' ? '.' : local.replaceAll('\\', '/');
        files.add(file);
        return file;
    };
    for (const line of typeof command === 'string' ? [command] : command) {
        segmentCwd = typeof line === 'string' ? cwd : line.cwd;
        for (const segment of (typeof line === 'string' ? line : line.command).split(/&&|\|\||[;&|\n]/)) {
            const tokens = [...segment.matchAll(TOKEN)].map(match => match[1] ?? match[2] ?? match[3] ?? '');
            // `cd <dir>` moves later segments when it stays in the checkout; `cd`, `cd -` and `~` keep the cwd.
            if (tokens[0] === 'cd') {
                const target = tokens[1];
                if (target !== undefined && target !== '-' && !target.startsWith('~') && within(resolve(segmentCwd, target)) !== undefined) segmentCwd = resolve(segmentCwd, target);
                continue;
            }
            let index = 0;
            for (;;) {
                while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]!)) index += 1;
                const word = tokens[index]?.toLowerCase();
                if (word === 'cmd' || word === 'cmd.exe') {
                    const run = tokens.findIndex((token, at) => at > index && /^\/[ck]$/i.test(token));
                    index = run < 0 ? tokens.length : run + 1;
                    continue;
                }
                if (word === undefined || !WRAPPERS.has(word)) break;
                const wrapper = word;
                index += 1;
                while (index < tokens.length && tokens[index]!.startsWith('-')) index += wrapper === 'sudo' && SUDO_VALUED.has(tokens[index]!) ? 2 : 1;
            }
            const program = tokens[index];
            if (program === undefined) continue;
            if (/[\\/]/.test(program) || /\.(?:cmd|bat|ps1)$/i.test(program)) add(program);
            const family = familyOf(program);
            if (!family) continue;
            const normalize = (flag: string) => family.caseInsensitive ? flag.toLowerCase() : flag;
            let operand = index + 1;
            if (family.subcommand !== undefined && tokens[operand] === family.subcommand) operand += 1;
            while (operand < tokens.length) {
                const token = tokens[operand]!;
                const flag = normalize(token);
                if (family.inline.includes(flag)) break;
                if (family.script?.includes(flag)) { if (tokens[operand + 1] !== undefined) add(tokens[operand + 1]!); break; }
                if (token.startsWith('-') || token.startsWith('+') && family === SHELL) {
                    operand += family.valued?.includes(flag) ? 2 : 1;
                    continue;
                }
                const file = add(token);
                if (file && family.packageEntry) packageOperands.add(file);
                break;
            }
        }
    }
    return { files, packageOperands };
}

export type LiteralCommandFileFactV1 = Readonly<ProjectCommandFileFactV1>;

/**
 * The reviewed facts for those files. A present in-checkout file contributes its bytes; an
 * absent one is recorded so adding it asks again; a link out of the checkout (a venv's
 * `bin/python`) contributes its target path, because outside bytes are not Project inputs.
 * A directory operand (`node server`) is recorded without reading what it loads.
 * `files` names further checkout-relative inputs a native definition loads directly
 * (a flake's `.nix` files, a mise task `file`); they become facts the same way.
 */
export async function readLiteralCommandExecutedFiles(root: string, cwd: string, command: LiteralCommandLines,
    options: Readonly<{ files?: readonly string[]; io: LiteralCommandFileIo }>)
    : Promise<Readonly<{ kind: 'read'; files: LiteralCommandFileFactV1[] }> | Readonly<{ kind: 'refused'; code: string }>> {
    const scan = scanLiteralCommand(root, cwd, command);
    const { io } = options;
    for (const file of options.files ?? []) {
        const local = relative(root, resolve(root, file.replaceAll('\\', '/')));
        if (local && local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local)) scan.files.add(local.replaceAll('\\', '/'));
    }
    const facts = new Map<string, LiteralCommandFileFactV1>();
    const read = async (file: string): Promise<LiteralCommandFileFactV1 | Readonly<{ refused: string }>> => {
        const result = await io.readBytes(root, file);
        if (result.kind === 'read') return { file, digest: createHash('sha256').update(result.bytes).digest('hex') };
        if (result.kind === 'absent') return { file, absent: true };
        try {
            const target = await io.realpath(resolve(root, file));
            if (result.code === 'outside_root') return { file, linkTarget: target };
            if ((await io.stat(target)).isDirectory()) return { file, directory: true };
            return { refused: result.code };
        } catch (error) {
            const code = error instanceof Error && 'code' in error ? error.code : undefined;
            return code === 'ENOENT' || code === 'ENOTDIR' ? { file, absent: true } : { refused: 'unreadable_definition' };
        }
    };
    const record = async (file: string) => {
        if (facts.has(file)) return null;
        const fact = await read(file);
        if ('refused' in fact) return fact.refused;
        facts.set(file, fact);
        return null;
    };
    for (const file of scan.files) {
        const refused = await record(file);
        if (refused) return { kind: 'refused', code: refused };
        // Node loads a folder through its package.json `main`; deeper imports are setupInputs.
        if (!scan.packageOperands.has(file) || !('directory' in facts.get(file)!)) continue;
        const manifest = file === '.' ? 'package.json' : `${file}/package.json`;
        let main = 'index.js';
        const manifestBytes = await io.readBytes(root, manifest);
        if (manifestBytes.kind === 'read') {
            facts.set(manifest, { file: manifest, digest: createHash('sha256').update(manifestBytes.bytes).digest('hex') });
            try {
                const parsed: unknown = JSON.parse(new TextDecoder().decode(manifestBytes.bytes));
                if (parsed && typeof parsed === 'object' && 'main' in parsed && typeof parsed.main === 'string' && parsed.main.trim()) main = parsed.main;
            } catch { /* An invalid manifest's bytes are already the reviewed fact; Node falls back to index.js. */ }
        } else {
            const manifestRefused = await record(manifest);
            if (manifestRefused) return { kind: 'refused', code: manifestRefused };
        }
        const entry = relative(root, resolve(root, file, main));
        if (entry === '' || entry === '..' || entry.startsWith(`..${sep}`) || isAbsolute(entry)) continue;
        // Node's order: the exact file, its .js/.mjs/.cjs forms, then a folder's index.js. The
        // first present one is the entry; when none is, all are recorded absent so adding one asks again.
        const candidates = [entry, `${entry}.js`, `${entry}.mjs`, `${entry}.cjs`, join(entry, 'index.js')].map(path => path.replaceAll('\\', '/'));
        const missing: LiteralCommandFileFactV1[] = [];
        let found = false;
        for (const candidate of candidates) {
            if (facts.has(candidate)) { found = true; break; }
            const fact = await read(candidate);
            if ('refused' in fact) return { kind: 'refused', code: fact.refused };
            if ('digest' in fact || 'linkTarget' in fact) { facts.set(candidate, fact); found = true; break; }
            if ('absent' in fact) missing.push(fact);
        }
        if (!found) for (const fact of missing) facts.set(fact.file, fact);
    }
    return { kind: 'read', files: [...facts.values()].sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0) };
}
