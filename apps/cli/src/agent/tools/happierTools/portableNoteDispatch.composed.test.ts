import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fastify from 'fastify';
import { expect, it } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import { registerAuthoredAccountActionRelease } from '@/plugins/runtime/accountPluginActions.testkit';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';

it('dispatches the W30 required-note Account declaration through the real credentialed executor', async () => {
    const home = await mkdtemp(join(tmpdir(), 'portable-note-dispatch-'));
    const app = fastify();
    const plugin = definePlugin({ id: 'qa.w30-portable', version: '0.1.0', actions: {
        note: { title: 'W30 portable note', surfaces: ['ui', 'cli', 'agent', 'plugin'], scopes: ['global'],
            placementBindings: ['commandPalette'], dangerLevel: 'safe',
            execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activate' } },
            inputSchema: defineProtocolObject({ note: defineProtocolString() }, { policy: 'closed' }),
            run: async input => ({ note: input.note, marker: 'w30-portable' }),
        },
    } });
    await writeFile(join(home, 'package.json'), JSON.stringify({ name: 'qa.w30-portable' }));
    const entryPath = join(home, 'account.ts');
    await writeFile(entryPath, `import { definePlugin } from '@happier-dev/plugin-sdk';
import { defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
export const { manifest, activateAccount: activate } = definePlugin({id:'qa.w30-portable',version:'0.1.0',actions:{note:{
title:'W30 portable note',surfaces:['ui','cli','agent','plugin'],scopes:['global'],placementBindings:['commandPalette'],dangerLevel:'safe',
execution:{target:'account',account:{artifactId:'account-runtime',exportName:'activate'}},
inputSchema:defineProtocolObject({note:defineProtocolString()},{policy:'closed'}),run:async input=>({note:input.note,marker:'w30-portable'})}}});`);
    let restore: (() => void) | undefined;
    try {
        await registerAuthoredAccountActionRelease(app, 'owner', { primary: {
            manifest: plugin.manifest, projectRoot: home, entryPath, activateExport: 'activate',
        } });
        app.get('/v1/account/encryption/currentness', async () => ({ mode: 'plain', version: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
        app.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 1 }));
        await app.ready();
        restore = installAxiosFastifyAdapter({ app, origin: 'http://portable-note-dispatch.test' });
        const executor = createCliActionExecutor({ token: 'fixture', credentials: {
            token: 'fixture', encryption: null, credentialProvenance: 'stored_session' },
            happyHomeDir: home, sessionId: 'cli-global', mode: 'plain', ctx: null, serverId: 'portable-note-dispatch',
            serverHttpBaseUrl: 'http://portable-note-dispatch.test' });
        const result = await executor.execute('action.invoke', { action: { pluginId: plugin.manifest.id, localId: 'note' },
            input: { note: 'synthetic-note' } }, { surface: 'ui', actionCaller: { kind: 'host' } });
        expect(result).toMatchObject({ ok: true, result: { note: 'synthetic-note', marker: 'w30-portable' } });
        const refused = await executor.execute('action.invoke', { action: { pluginId: plugin.manifest.id, localId: 'note' },
            input: {} }, { surface: 'ui', actionCaller: { kind: 'host' } });
        expect(refused).toMatchObject({ ok: false, details: { issues: expect.arrayContaining([
            expect.objectContaining({ path: ['note'], code: expect.any(String) }),
        ]) } });
    } finally { restore?.(); await app.close(); await rm(home, { recursive: true, force: true }); }
});
