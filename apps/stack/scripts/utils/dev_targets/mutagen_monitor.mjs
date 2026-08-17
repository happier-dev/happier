const MUTAGEN_MONITOR_TEMPLATE = '{{range .}}{{printf "%s|%s|%d|%s|%t|%d\\n" .Name .Status .SuccessfulCycles .LastError .Paused (len .Conflicts)}}{{end}}';

export function buildMutagenMonitorArgs(sessionNames) {
  return [
    'sync',
    'monitor',
    '--template',
    MUTAGEN_MONITOR_TEMPLATE,
    ...sessionNames,
  ];
}

export function createMutagenMonitorLineFilter() {
  const latestBySession = new Map();
  return ({ stream, line }) => {
    if (stream !== 'stdout') return true;
    const separator = line.indexOf('|');
    if (separator <= 0) return line.trim().length > 0;
    const session = line.slice(0, separator);
    const fields = line.slice(separator + 1).split('|');
    const semanticState = fields.length >= 5
      ? [fields[0], ...fields.slice(2)].join('|')
      : line.slice(separator + 1);
    if (latestBySession.get(session) === semanticState) return false;
    latestBySession.set(session, semanticState);
    return true;
  };
}
