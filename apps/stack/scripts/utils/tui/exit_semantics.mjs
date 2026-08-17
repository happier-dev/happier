export function resolveTuiExitPolicy({ explicit = false } = {}) {
  return explicit
    ? { terminateChild: true, terminateTauri: true, stopRuntime: true }
    : { terminateChild: false, terminateTauri: true, stopRuntime: false };
}

export async function applyTuiExitPolicy({
  exitPolicy = resolveTuiExitPolicy(),
  terminateChildren = async () => {},
  terminateTauri = async () => {},
  stopRuntime = async () => {},
} = {}) {
  if (exitPolicy.terminateChild) await terminateChildren();
  if (exitPolicy.terminateTauri) await terminateTauri();
  if (exitPolicy.stopRuntime) await stopRuntime();
  return exitPolicy;
}
