export function toPort(value) {
  const port = Number(value);
  return Number.isFinite(port) && port > 0 ? Math.floor(port) : null;
}

export function buildBorrowedExpoWebappUrl({ consumerHost, expoPort }) {
  const host = String(consumerHost ?? '').trim();
  const normalizedExpoPort = toPort(expoPort);
  if (!host || !normalizedExpoPort) return null;
  return new URL(`http://${host}:${normalizedExpoPort}/`).origin;
}

export function buildBorrowedExpoUiUrl({ consumerHost, expoPort, serverPort }) {
  const host = String(consumerHost ?? '').trim();
  const webappUrl = buildBorrowedExpoWebappUrl({ consumerHost, expoPort });
  const normalizedServerPort = toPort(serverPort);
  if (!webappUrl || !normalizedServerPort) return null;

  const url = new URL(`${webappUrl}/`);
  url.searchParams.set('server', `http://${host}:${normalizedServerPort}`);
  url.searchParams.set('happier_hmr', '0');
  return url.toString();
}
