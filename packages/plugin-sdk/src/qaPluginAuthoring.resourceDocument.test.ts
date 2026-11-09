import { createTestResourceInvocationContext } from '@happier-dev/plugin-sdk/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { createPluginTestkit, type PluginTestkit } from '@happier-dev/plugin-sdk/testing';
import * as module from '../fixtures/qa-plugin-authoring/qa-resource-document/src/index.js';

let plugin: PluginTestkit | undefined;
afterEach(async () => { await plugin?.dispose(); plugin = undefined; });

async function openDocument() {
    plugin = await createPluginTestkit({ manifest: module.manifest, module });
    await plugin.invokeAction('document-write', { text: '' });
    const resource = plugin.registration('resources', 'document');
    if (!resource) throw new Error('Document Resource was not registered');
    const controller = new AbortController();
    const options = createTestResourceInvocationContext({
        signal: controller.signal, context: { kind: 'global' },
    });
    return { plugin, resource, controller, options };
}

describe('QA public Resource document author package', () => {
    it('updates the Resource through the same Action on agent, CLI, MCP and UI surfaces', async () => {
        const { plugin, resource, options } = await openDocument();
        for (const surface of ['agent', 'cli', 'mcp', 'ui'] as const) {
            const text = `# Review notes\nSaved from ${surface}.`;
            await expect(plugin.invokeAction('document-write', { text }, { surface })).resolves.toEqual({ text });
            expect(await resource.read(options)).toBe(text);
        }
        await expect(plugin.invokeAction('document-write', { text: '' })).resolves.toEqual({ text: '' });
        expect(await resource.read(options)).toBe('');
    });

    it('invalidates each live reader, suppresses equal writes and disposes observations', async () => {
        const { plugin, resource, controller, options } = await openDocument();
        const seen: string[] = [];
        const first = await resource.observe(() => { seen.push('first'); }, options);
        const second = await resource.observe(() => { seen.push('second'); }, options);
        await plugin.invokeAction('document-write', { text: 'First draft' });
        expect(seen).toEqual(['first', 'second']);
        expect(await resource.read(options)).toBe('First draft');
        await plugin.invokeAction('document-write', { text: 'First draft' });
        expect(seen).toEqual(['first', 'second']);
        await first.dispose(); await first.dispose();
        await plugin.invokeAction('document-write', { text: 'Second draft' });
        expect(seen).toEqual(['first', 'second', 'second']);
        controller.abort(); await second.dispose();
        await plugin.invokeAction('document-write', { text: 'Final draft' });
        expect(seen).toEqual(['first', 'second', 'second']);
        expect(() => resource.read(options)).toThrow();
    });

    it('rejects malformed or cancelled writes without changing readable bytes', async () => {
        const { plugin, resource, options } = await openDocument();
        await plugin.invokeAction('document-write', { text: 'Retain this draft' });
        await expect(plugin.invokeAction('document-write', { text: 9 })).rejects.toThrow();
        await expect(plugin.invokeAction('document-write', { text: 'wrong', extra: true })).rejects.toThrow();
        const controller = new AbortController(); controller.abort();
        await expect(plugin.invokeAction('document-write', { text: 'cancelled' }, { signal: controller.signal })).rejects.toThrow();
        expect(await resource.read(options)).toBe('Retain this draft');
    });
});
