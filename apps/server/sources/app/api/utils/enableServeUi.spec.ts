import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { enableServeUi } from './enableServeUi';

async function withTempDir(prefix: string, run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function withApp(run: (app: ReturnType<typeof Fastify>) => Promise<void>) {
  const app = Fastify();
  try {
    await run(app);
  } finally {
    await app.close().catch(() => {});
  }
}

describe('enableServeUi (mountRoot)', () => {
  it('serves index.html for SPA routes when mounted at root', async () => {
    await withTempDir('happier-ui-root-', async (dir) => {
      await writeFile(join(dir, 'index.html'), '<!doctype html><html><body>ok</body></html>\n', 'utf-8');

      await withApp(async (app) => {
        enableServeUi(app, { dir, prefix: '/', mountRoot: true, required: false });
        await app.ready();

        const res = await app.inject({ method: 'GET', url: '/terminal/connect' });
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toMatch(/text\/html/i);
        expect(res.body).toContain('ok');
        expect(res.body).toContain('Welcome to Happier Server!');
      });
    });
  });

  it('serves index.html for SPA routes that contain dots in the path', async () => {
    await withTempDir('happier-ui-root-dots-', async (dir) => {
      await writeFile(join(dir, 'index.html'), '<!doctype html><html><body>ok</body></html>\n', 'utf-8');

      await withApp(async (app) => {
        enableServeUi(app, { dir, prefix: '/', mountRoot: true, required: false });
        await app.ready();

        const res = await app.inject({ method: 'GET', url: '/user.profile' });
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toMatch(/text\/html/i);
        expect(res.body).toContain('ok');
        expect(res.body).toContain('Welcome to Happier Server!');
      });
    });
  });

  it('shows helpful HTML when index.html is missing', async () => {
    await withTempDir('happier-ui-missing-', async (dir) => {
      await withApp(async (app) => {
        enableServeUi(app, { dir, prefix: '/', mountRoot: true, required: false });
        await app.ready();

        const res = await app.inject({ method: 'GET', url: '/' });
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toMatch(/text\/html/i);
        expect(res.body).toContain('hstack build');
        expect(res.body).toContain('Welcome to Happier Server!');
      });
    });
  });

  it('does not leak absolute index.html path when NODE_ENV=production', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    await withTempDir('happier-ui-missing-prod-', async (dir) => {
      try {
        process.env.NODE_ENV = 'production';
        await withApp(async (app) => {
          enableServeUi(app, { dir, prefix: '/', mountRoot: true, required: false });
          await app.ready();

          const res = await app.inject({ method: 'GET', url: '/' });
          expect(res.statusCode).toBe(200);
          expect(res.headers['content-type']).toMatch(/text\/html/i);
          expect(res.body).toContain('UI bundle is missing');
          expect(res.body).not.toContain(join(dir, 'index.html'));
        });
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
      }
    });
  });

  it('serves .map files with application/json content-type', async () => {
    await withTempDir('happier-ui-root-map-', async (dir) => {
      await writeFile(join(dir, 'index.html'), '<!doctype html><html><body>ok</body></html>\n', 'utf-8');
      await writeFile(join(dir, 'main.js.map'), JSON.stringify({ version: 3 }) + '\n', 'utf-8');

      await withApp(async (app) => {
        enableServeUi(app, { dir, prefix: '/', mountRoot: true, required: false });
        await app.ready();

        const res = await app.inject({ method: 'GET', url: '/main.js.map' });
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toMatch(/application\/json/i);
        expect(res.body).toContain('"version":3');
      });
    });
  });

  it('does not rewrite unknown API routes to index.html when mounted at root', async () => {
    await withTempDir('happier-ui-root-api-404-', async (dir) => {
      await writeFile(join(dir, 'index.html'), '<!doctype html><html><body>ok</body></html>\n', 'utf-8');

      await withApp(async (app) => {
        enableServeUi(app, { dir, prefix: '/', mountRoot: true, required: false });
        await app.ready();

        const res = await app.inject({ method: 'GET', url: '/v1/unknown-route' });
        expect(res.statusCode).toBe(404);
        expect(res.headers['content-type']).toMatch(/application\/json/i);
        expect(res.body).toContain('Not found');
      });
    });
  });

  it('fails closed at startup when UI is required and index.html is missing', async () => {
    await withTempDir('happier-ui-missing-required-', async (dir) => {
      await withApp(async (app) => {
        expect(() => enableServeUi(app, { dir, prefix: '/', mountRoot: true, required: true })).toThrow(/index\.html/i);
      });
    });
  });
});
