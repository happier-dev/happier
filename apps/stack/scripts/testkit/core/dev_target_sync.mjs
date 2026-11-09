// Mutagen is an external process boundary. These fixtures use its public
// sync-list model so source admission and readiness parsing remain real.
export function readyDevTargetSyncResult(sessionName = 'happier-linux', { native = false } = {}) {
  const session = {
    name: sessionName, paused: false, status: 'watching', successfulCycles: 3,
    alpha: { connected: true, scanned: true }, beta: { connected: true, scanned: true },
  };
  // The JavaScript and native admission owners request different Mutagen templates.
  const out = native ? [
    session.name, 'Watching', session.paused,
    session.alpha.connected, Number(session.alpha.scanned), '0/0', '0/0',
    session.beta.connected, Number(session.beta.scanned), '0/0', '0/0',
    'active', session.successfulCycles, 'ok', 0, 0,
  ].join('|') + '\n' : JSON.stringify([session]);
  return { ok: true, exitCode: 0, out, err: '' };
}

export function captureDevTargetSyncFixture(command, args) {
  if (command !== 'mutagen' && !args.includes('mutagen')) return null;
  const index = args.indexOf('sync');
  if (index < 0) return null;
  if (args[index + 1] === 'list') {
    const templateIndex = args.indexOf('--template');
    const template = templateIndex >= 0 ? args[templateIndex + 1] ?? '' : '';
    return readyDevTargetSyncResult(args[index + 2], {
      native: template.includes('{{.Name}}|{{.Status}}|'),
    });
  }
  if (args[index + 1] === 'flush') return { ok: true, exitCode: 0, out: '', err: '' };
  return null;
}
