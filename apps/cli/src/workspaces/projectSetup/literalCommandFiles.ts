import { createHash } from 'node:crypto';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';

import { currentWorkspaceSource } from '@/workspaces/source/workspaceSource';
import { readProjectDefinitionFileBytes } from './nativeDefinitionFiles';

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
}>;

const SHELL: Family = { inline: ['-c'], valued: ['-o', '+o', '-O', '+O'] };
const NODE: Family = { inline: ['-e', '-p', '--eval', '--print'], valued: ['-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions'] };
const FAMILIES: Readonly<Record<string, Family>> = {
    sh: SHELL, bash: SHELL, zsh: SHELL, dash: SHELL, ksh: SHELL, fish: SHELL,
    source: { inline: [] }, '.': { inline: [] },
    node: NODE, tsx: NODE,
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
    const files = new Set<string>();
    const add = (token: string) => {
        const local = relative(root, resolve(cwd, token));
        if (local !== '' && local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local)) files.add(local.replaceAll('\\', '/'));
    };
    for (const segment of command.split(/&&|\|\||[;&|\n]/)) {
        const tokens = [...segment.matchAll(TOKEN)].map(match => match[1] ?? match[2] ?? match[3] ?? '');
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
            add(token);
            break;
        }
    }
    return [...files];
}

export type LiteralCommandFileFactV1 = Readonly<{ file: string; digest: string } | { file: string; absent: true } | { file: string; linkTarget: string }>;

/**
 * The reviewed facts for those files. A present in-checkout file contributes its bytes; an
 * absent one is recorded so adding it asks again; a link out of the checkout (a venv's
 * `bin/python`) contributes its target path, because outside bytes are not Project inputs.
 */
export async function readLiteralCommandExecutedFiles(root: string, cwd: string, command: string)
    : Promise<Readonly<{ kind: 'read'; files: LiteralCommandFileFactV1[] }> | Readonly<{ kind: 'refused'; code: string }>> {
    const files: LiteralCommandFileFactV1[] = [];
    for (const file of listLiteralCommandExecutedFiles(root, cwd, command).sort()) {
        const read = await readProjectDefinitionFileBytes(root, file);
        if (read.kind === 'read') files.push({ file, digest: createHash('sha256').update(read.bytes).digest('hex') });
        else if (read.kind === 'absent') files.push({ file, absent: true });
        else if (read.code === 'outside_root') {
            try { files.push({ file, linkTarget: await currentWorkspaceSource().realpath(resolve(root, file)) }); }
            catch { return { kind: 'refused', code: 'unreadable_definition' }; }
        } else return { kind: 'refused', code: read.code };
    }
    return { kind: 'read', files };
}
