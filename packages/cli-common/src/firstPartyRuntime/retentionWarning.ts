export function warnFirstPartyRetentionObservationUnavailable(onWarning?: (message: string) => void): void {
  const message = 'Skipped older payload cleanup because ps/lsof could not establish whether versions are in use; older versions were retained.';
  if (onWarning) onWarning(message);
  else if (typeof process !== 'undefined' && process.stderr?.write) process.stderr.write(`[happier] ${message}\n`);
  else console.warn(`[happier] ${message}`);
}
