import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

export type StopFn = () => Promise<void>;

export async function startFakeGitHubOAuthServer(): Promise<{
  baseUrl: string;
  stop: StopFn;
  getCounts: () => Readonly<Record<string, number>>;
}> {
  const counts: Record<string, number> = {};
  const inc = (key: string) => {
    counts[key] = (counts[key] ?? 0) + 1;
  };

  const srv = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname;

    if (pathname === '/login/oauth/authorize') {
      inc('authorize');
      const redirectUri = url.searchParams.get('redirect_uri') ?? '';
      const state = url.searchParams.get('state') ?? '';
      if (!redirectUri || !state) {
        res.statusCode = 400;
        res.end('missing redirect params');
        return;
      }
      const redirect = new URL(redirectUri);
      redirect.searchParams.set('code', 'fake_code_1');
      redirect.searchParams.set('state', state);
      res.statusCode = 302;
      res.setHeader('location', redirect.toString());
      res.end();
      return;
    }

    if (pathname === '/login/oauth/access_token') {
      inc('token');
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ access_token: 'tok_1' }));
      return;
    }

    if (pathname === '/user') {
      inc('user');
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          id: 123,
          login: 'octocat',
          avatar_url: 'https://avatars.example.test/octo.png',
          name: 'Octo Cat',
        }),
      );
      return;
    }

    res.statusCode = 404;
    res.end('not found');
  });

  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const addr = srv.address();
  if (!addr || typeof addr !== 'object') throw new Error('fake oauth server missing address');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    baseUrl,
    stop: async () => {
      srv.close();
      await once(srv, 'close');
    },
    getCounts: () => ({ ...counts }),
  };
}

