import { rename, rm, stat } from 'node:fs/promises';

export async function replaceDirectoryPreservingLastGood({ stagedPath, destinationPath, validate }) {
  const backupPath = `${destinationPath}.previous-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let movedExisting = false;
  let installed = false;
  let backupRetained = false;

  try {
    if (await pathExists(destinationPath)) {
      await rename(destinationPath, backupPath);
      movedExisting = true;
    }
    await rename(stagedPath, destinationPath);
    installed = true;

    const persisted = await validate();
    if (persisted.status !== 'ok') {
      throw new Error(`Persisted native build input failed validation: ${persisted.reason ?? 'unknown-reason'}.`);
    }
    return persisted;
  } catch (error) {
    if (installed) await rm(destinationPath, { force: true, recursive: true });
    if (movedExisting && await pathExists(backupPath)) {
      try {
        await rename(backupPath, destinationPath);
      } catch (restoreError) {
        backupRetained = true;
        throw new AggregateError(
          [error, restoreError],
          `Native build input replacement failed; last-known-good input remains at ${backupPath}.`,
        );
      }
    }
    throw error;
  } finally {
    if (!backupRetained) {
      await rm(backupPath, { force: true, recursive: true });
    }
  }
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
