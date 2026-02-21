import { createServer as createNetServer } from 'node:net';

export async function reserveAvailablePort(): Promise<number> {
  return await new Promise<number>((resolvePort, reject) => {
    const srv = createNetServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr !== 'object') {
        srv.close(() => reject(new Error('missing address')));
        return;
      }
      const port = addr.port;
      srv.close((err) => {
        if (err) reject(err);
        else resolvePort(port);
      });
    });
  });
}

