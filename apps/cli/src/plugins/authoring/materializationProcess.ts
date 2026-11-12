import type { materializePrepublicationWorkspacePackageRoots } from '@happier-dev/cli-common/workspaces';

type MaterializationInput = Parameters<typeof materializePrepublicationWorkspacePackageRoots>[0];
type MaterializationResponse =
  | Readonly<{ ok: true; packageNames: readonly string[] }>
  | Readonly<{ ok: false; error: Readonly<{ message: string; code?: string | number }> }>;

/** The synchronous package publisher stays in one owner, outside the daemon's heartbeat loop. */
export async function materializeAuthorPackagesInChild(
  input: MaterializationInput,
): Promise<readonly string[]> {
  const { spawnHappyCLI } = await import('@/utils/spawnHappyCLI');
  const child = spawnHappyCLI(['daemon', 'plugin-author-materialize-worker'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return await new Promise<readonly string[]>((resolve, reject) => {
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stdout!.on('data', (chunk: Buffer) => output.push(chunk));
    child.stderr!.on('data', (chunk: Buffer) => errors.push(chunk));
    child.once('error', reject);
    // An exited child may close stdin before end() drains. Its close result
    // below owns settlement, including its native exit or signal.
    child.stdin!.on('error', () => {});
    child.once('close', (exitCode, signal) => {
      if (exitCode !== 0 || signal !== null) {
        reject(Object.assign(new Error(Buffer.concat(errors).toString('utf8').trim()
          || 'Plugin SDK materialization child exited before returning its result'), {
          code: signal ?? exitCode,
        }));
        return;
      }
      try {
        // Private output from our own child; both ends use this module's type.
        const response = JSON.parse(Buffer.concat(output).toString('utf8')) as MaterializationResponse;
        if (response.ok) resolve(response.packageNames);
        else reject(Object.assign(new Error(response.error.message), {
          ...(response.error.code === undefined ? {} : { code: response.error.code }),
        }));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin!.end(JSON.stringify(input));
  });
}

/** Hidden finite CLI role; it never starts a daemon or makes an activation decision. */
export async function runPluginAuthorMaterializationChild(): Promise<void> {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  let response: MaterializationResponse;
  try {
    // The admitted parent supplies the same internal publisher input as before.
    const request = JSON.parse(input) as MaterializationInput;
    const { materializePrepublicationWorkspacePackageRoots } = await import('@happier-dev/cli-common/workspaces');
    response = { ok: true, packageNames: materializePrepublicationWorkspacePackageRoots(request) };
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    response = { ok: false, error: {
      message: error instanceof Error ? error.message : String(error),
      ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}),
    } };
  }
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(JSON.stringify(response), (error) => error ? reject(error) : resolve());
  });
}
