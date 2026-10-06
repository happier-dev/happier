import { resolve } from 'node:path';
import { extractShellCommand } from '@happier-dev/protocol/activity/shellCommand';
import { expandHomeDirPath, isCanonicalAbsolutePathInsideRoot, resolveCanonicalAbsolutePath } from '@/utils/path/expandHomeDirPath';
import { realpathWithAbsentSuffix } from '@/utils/path/physicalAncestorPath';
import { isDefaultReadOnlyToolName } from './writeLikeToolNameHeuristics';

const CREDENTIAL_ACCESS_PATTERN = /(?:\.env(?:\W|$)|[\\/]\.(?:ssh|aws|kube)[\\/]|[\\/]\.(?:netrc|npmrc|gitcredentials)(?:\W|$)|[\\/](?:shadow|id_rsa|id_ed25519|auth\.json|oauth_creds\.json)(?:\W|$)|\.(?:key|pem|p12|pfx)(?:\W|$)|credentials?|password|passwd|secret|private[_ -]?key|access[_ -]?token|api[_ -]?key|process\.env|printenv)/i;

/** Raw-input safety admission, before redaction or any model disclosure. Unknown effects escalate. */
export async function isApprovalReviewerModelEligible(toolName: string, input: unknown, cwd: string): Promise<boolean> {
    if (!cwd) return false;
    let raw: string;
    try { raw = JSON.stringify(input) ?? ''; } catch { return false; }
    // Credentials include paths, environment access and credential-management operations.
    if (CREDENTIAL_ACCESS_PATTERN.test(raw + toolName)) return false;
    if (/fetch|http|network|browser|web|upload|download/i.test(toolName)) return false;

    const command = extractShellCommand(input);
    if (command !== null && command !== undefined && command.trim()) {
        if (!/^(?:bash|shell|execute|exec_command|run_command|terminal)$/i.test(toolName.trim())) return false;
        // Shell is executable code: only simple inspection commands are model-reviewable.
        // Pipelines, interpreters, substitutions and unknown executables can hide any escalation class.
        if (/[;&|<>`$\n\r\\]/.test(command)) return false;
        if (/\b(?:push|rm|rmdir|del|erase|Remove-Item|format|mkfs|dd|shred|truncate|reset|clean|checkout|restore|switch)\b/i.test(command)) return false;
        // Even inspection tools have executable/output options (find -exec,
        // git --ext-diff/--output). Do not treat a command prefix as an effect proof.
        return /^(?:pwd|git status(?: --short| --porcelain| -s)?)$/i.test(command.trim());
    }

    const name = toolName.trim().toLowerCase();
    const write = /^(?:write|edit|multiedit|writefile|write_file|writetextfile|write_text_file|apply_patch|patch)$/.test(name);
    const read = isDefaultReadOnlyToolName(toolName);
    if (!write && !read) return false;
    if (!input || typeof input !== 'object' || Array.isArray(input)) return !write;
    const record = input as Record<string, unknown>;
    const paths = ['file_path', 'filePath', 'path', 'absolutePath'].flatMap((key) => typeof record[key] === 'string' ? [record[key] as string] : []);
    if (Array.isArray(record.edits)) {
        for (const edit of record.edits) {
            if (!edit || typeof edit !== 'object') return false;
            const entry = edit as Record<string, unknown>;
            const path = entry.file_path ?? entry.filePath ?? entry.path;
            if (typeof path !== 'string') return false;
            paths.push(path);
        }
    }
    if (paths.length === 0) return !write;
    try {
        const canonicalRoot = resolveCanonicalAbsolutePath(cwd);
        if (!canonicalRoot) return false;
        const root = await realpathWithAbsentSuffix(canonicalRoot.path);
        for (const path of paths) {
            const expanded = expandHomeDirPath(path.trim());
            // A foreign absolute spelling cannot be anchored as a relative local file.
            if (!expanded || expanded.includes('\0') || (process.platform !== 'win32' && /^(?:[a-z]:[\\/]|\\\\)/i.test(expanded))) return false;
            const canonicalTarget = resolveCanonicalAbsolutePath(resolve(canonicalRoot.path, expanded.replaceAll('\\', '/')));
            if (!canonicalTarget) return false;
            const target = await realpathWithAbsentSuffix(canonicalTarget.path);
            if (CREDENTIAL_ACCESS_PATTERN.test(target)) return false;
            if (write && !isCanonicalAbsolutePathInsideRoot(root, target)) return false;
        }
        return true;
    } catch { return false; }
}
