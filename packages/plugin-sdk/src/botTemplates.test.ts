import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { botTemplateAuthoring } from '../examples/public-authoring/botTemplates.js';
import { parsePluginManifest } from './manifest.js';
import { ingestPluginManifestV2 } from '@happier-dev/protocol/plugins/manifest/ingest';
import { PLUGIN_CONTRIBUTION_CATALOG_V2 } from '@happier-dev/protocol/plugins/contributions/catalog';
import { readBotTemplateReleaseV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';

it('round trips multiple public author descriptors into BT2 releases without runtime registration', async () => {
    const parsed = parsePluginManifest(botTemplateAuthoring.manifest);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
    expect(parsed.manifest.contributes.botTemplates).toEqual([
        { id: 'researcher', path: 'templates/researcher.json' },
        { id: 'reviewer', path: './templates/reviewer.json' },
    ]);
    const family = PLUGIN_CONTRIBUTION_CATALOG_V2.find(entry => entry.manifestKey === 'botTemplates');
    expect(family).toMatchObject({ activationDemand: 'none', allowedRuntimeRegistration: null, projectionFamily: 'botTemplates' });
    for (const descriptor of parsed.manifest.contributes.botTemplates) {
        const bytes = await readFile(new URL(`../examples/public-authoring/${descriptor.path}`, import.meta.url), 'utf8');
        expect(readBotTemplateReleaseV1(JSON.parse(bytes))).toMatchObject({
            version: '1.0.0', content: { identity: { name: expect.any(String) } },
        });
    }
});

it('strict authors reject unsafe or unknown descriptors while tolerant loading retains healthy siblings', () => {
    for (const invalid of [
        { id: 'bad', path: '../private.json' }, { id: 'bad', path: '/private.json' },
        { id: 'bad', path: 'templates\\private.json' }, { id: 'bad', path: 'templates/CON.json' },
        { id: 'bad', path: 'templates/template.json', source: 'artifact' },
    ]) {
        const input = { ...botTemplateAuthoring.manifest, contributes: {
            botTemplates: [{ id: 'healthy', path: 'templates/researcher.json' }, invalid],
        } };
        expect(ingestPluginManifestV2(input).ok).toBe(false);
        expect(ingestPluginManifestV2(input, { mode: 'load' })).toMatchObject({
            ok: true, manifest: { contributes: { botTemplates: [{ id: 'healthy', path: 'templates/researcher.json' }] } },
            diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'plugin_contribution_skipped' })]),
        });
    }
});
