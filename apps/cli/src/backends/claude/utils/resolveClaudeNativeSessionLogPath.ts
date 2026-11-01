import { realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { getProjectPath } from './path';
import { resolveConfiguredClaudeConfigDir } from './resolveConfiguredClaudeConfigDir';

export async function resolveClaudeNativeSessionLogPath(input: Readonly<{
  vendorResumeId: string;
  metadata?: Record<string, unknown>;
}>): Promise<string | null> {
  const id = input.vendorResumeId.trim();
  if (!id || id === '.' || id === '..' || /[\\/]/.test(id)) return null;
  const configDir = resolveConfiguredClaudeConfigDir({ env: process.env });
  const recordedPath = typeof input.metadata?.claudeTranscriptPath === 'string' ? input.metadata.claudeTranscriptPath : null;
  const workspace = typeof input.metadata?.path === 'string' ? input.metadata.path : null;
  const candidate = recordedPath ?? (workspace ? join(getProjectPath(workspace, configDir), `${id}.jsonl`) : null);
  if (!candidate || !isAbsolute(candidate) || basename(candidate) !== `${id}.jsonl`) return null;
  try {
    const [path, root] = await Promise.all([realpath(candidate), realpath(join(configDir, 'projects'))]);
    const rel = relative(root, path);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
    return (await stat(path)).isFile() ? path : null;
  } catch {
    return null;
  }
}
