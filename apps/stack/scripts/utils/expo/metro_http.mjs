import { get } from 'node:http';

// Observe the existing HTTP deadline, including whether the connection was accepted.
// No second TCP probe: a connected, silent Metro is busy rather than absent.
export function readMetroHttp(url, { deadline, signal }) {
  return new Promise((resolve, reject) => {
    let connected = false;
    let response = null;
    let text = '';
    let settled = false;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0 || signal?.aborted) { reject(new Error('Metro observation ended')); return; }
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      request.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const snapshot = () => ({
      ok: response.statusCode >= 200 && response.statusCode < 300,
      contentType: String(response.headers['content-type'] ?? '').toLowerCase(),
      projectRoot: String(response.headers['x-react-native-project-root'] ?? '').trim(),
      text,
    });
    const request = get(url, { agent: false }, res => {
      response = res;
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => finish(null, snapshot()));
      res.on('error', error => finish(error));
    });
    request.on('socket', socket => socket.once('connect', () => { connected = true; }));
    request.on('error', error => finish(error));
    const cancel = () => finish(new Error('Metro observation cancelled'));
    const timer = setTimeout(() => {
      if (response) {
        const partial = snapshot();
        // Preserve the established project-root-header readiness contract.
        if (partial.ok && partial.projectRoot) { finish(null, partial); return; }
        if (!partial.ok) { finish(null, partial); return; }
      }
      finish(null, { busy: connected });
    }, remainingMs);
    signal?.addEventListener('abort', cancel, { once: true });
  });
}
