import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GITLAB_MR_TEMP_PREFIX = 'happier-gitlab-mr-';
const GITLAB_MR_BODY_FILENAME = 'description.md';

export type GitlabCliTempBodyDeps = Readonly<{
  makeTempDir(): Promise<string>;
  writeBodyFile(path: string, body: string): Promise<void>;
  removeTempDir(path: string): Promise<void>;
}>;

const defaultDeps: GitlabCliTempBodyDeps = Object.freeze({
  makeTempDir: () => mkdtemp(join(tmpdir(), GITLAB_MR_TEMP_PREFIX)),
  writeBodyFile: (path, body) => writeFile(path, body, { mode: 0o600 }),
  removeTempDir: (path) => rm(path, { recursive: true, force: true }),
});

export async function withGitlabCliTempBody<T>(
  body: string,
  callback: (fieldArg: string) => Promise<T>,
  deps: GitlabCliTempBodyDeps = defaultDeps,
): Promise<T> {
  const tempDir = await deps.makeTempDir();
  const bodyPath = join(tempDir, GITLAB_MR_BODY_FILENAME);
  await deps.writeBodyFile(bodyPath, body);

  try {
    return await callback(`description=@${bodyPath}`);
  } finally {
    await deps.removeTempDir(tempDir).catch(() => undefined);
  }
}
