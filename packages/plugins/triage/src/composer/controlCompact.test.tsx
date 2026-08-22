// @vitest-environment jsdom
import { act } from 'react';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { renderSurface as renderEntriesControlCompactSurface } from './controlCompact.js';

/**
 * The compact control label (`core/COMPOSER.md` §1.2).
 *
 * Zero, one and many are derived from the canonical composer snapshot on every
 * read. There is no chip list, no attachment count and no selected-items store
 * anywhere in this renderer — which is the whole point: a second store survives
 * a host badge removal, an undo and a closed scope, and then keeps claiming
 * attachments the message will not carry.
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SESSION_COMPOSER = Object.freeze({ kind: 'session', sessionId: 'session-1' });
const TRIAGE_ATTACHMENT = Object.freeze({ pluginId: 'happier.triage', localId: 'entry' });

const SOURCE = Object.freeze({ pluginId: 'happier.scm.forge.github', localId: 'github' });
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';

function entryValue(entryId: string) {
    return {
        v: 1,
        entryRef: { source: SOURCE, kindId: 'pull-request', collisionScope: 'example/repository', entryId },
        sourceInstance: { source: SOURCE, sourceInstanceId: INSTANCE_ID },
    };
}

function attachmentView(input: Readonly<{
    instanceId: string;
    label: string;
    entryId: string;
    attachment?: Readonly<{ pluginId: string; localId: string }>;
    icon?: string;
}>) {
    return {
        v: 1,
        instanceId: input.instanceId,
        attachment: input.attachment ?? TRIAGE_ATTACHMENT,
        key: input.instanceId.padEnd(43, 'x'),
        value: entryValue(input.entryId),
        presentation: {
            label: input.label,
            typeLabel: 'Pull request',
            ...(input.icon === undefined ? {} : { icon: input.icon }),
        },
        availability: { status: 'ready' },
    };
}

function snapshot(attachments: readonly unknown[]) {
    return {
        revision: 3,
        ref: SESSION_COMPOSER,
        text: 'please look at this',
        references: [],
        attachments,
        layout: 'wrap',
        capabilities: { text: true, references: true, attachments: true, submit: true },
        state: {
            focused: false,
            editable: true,
            submittable: true,
            submitting: false,
            running: false,
        },
    };
}

const mounted: PluginUiTestkit[] = [];

async function mountControl(options: Readonly<{
    attachments?: readonly unknown[];
    launchInput?: unknown;
    unavailable?: boolean;
    translations?: Readonly<Record<string, string>>;
}> = {}): Promise<PluginUiTestkit> {
    const launchInput = options.launchInput ?? {
        v: 1,
        role: 'controlCompact',
        composer: SESSION_COMPOSER,
        controlLocalId: 'entries',
        // The host's own state. The renderer must ignore it: it is the parallel
        // count the approved compact-state amendment exists to avoid.
        state: { selected: true, count: 99, label: 'Ninety-nine things' },
    };

    let fixture!: PluginUiTestkit;
    await act(async () => {
        fixture = await createPluginUiTestkit({
            identity: {
                pluginId: 'happier.triage',
                pluginVersion: '0.0.0',
                viewId: 'triage-entries-control',
                generation: 'control-mount',
            },
            surface: renderEntriesControlCompactSurface,
            surfaceContext: createSurfaceContextFixture(
                options.translations === undefined ? {} : { translations: options.translations },
            ),
            adapter: createPluginUiRnwSemanticSurfaceAdapter(),
            launchInput: launchInput as never,
            handlers: {
                readComposer: () => (options.unavailable === true
                    ? { status: 'unavailable', reason: 'scope_closed' }
                    : { status: 'ready', snapshot: snapshot(options.attachments ?? []) }) as never,
                watchComposer: () => undefined,
            },
        }) as PluginUiTestkit;
    });
    mounted.push(fixture);
    // The bind + read round trip is a microtask pair behind the mount.
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    return fixture;
}

afterEach(async () => {
    for (const fixture of mounted.splice(0)) await fixture.dispose();
});

describe('the Triage entries compact control', () => {
    it('shows the plain title, and no count, when nothing is attached', async () => {
        const control = await mountControl({ attachments: [] });

        await expect(control.getByText('PRs & Issues')).resolves.toEqual({ content: 'PRs & Issues' });
        await expect(control.queryByText('99')).resolves.toBeUndefined();
    });

    it('names the one attached entry', async () => {
        const control = await mountControl({
            attachments: [attachmentView({
                instanceId: 'a1',
                label: 'Replace the duplicated normalizer',
                entryId: '42',
            })],
        });

        await expect(control.getByText('Replace the duplicated normalizer')).resolves
            .toEqual({ content: 'Replace the duplicated normalizer' });
    });

    it('counts many attached entries from the snapshot, not from the host state', async () => {
        const control = await mountControl({
            attachments: [
                attachmentView({ instanceId: 'a1', label: 'First', entryId: '42' }),
                attachmentView({ instanceId: 'a2', label: 'Second', entryId: '43' }),
            ],
        });

        // Two, because two Triage records are in the draft — not ninety-nine,
        // which is what the host state claims, and not one label winning.
        await expect(control.getByText('2 PRs & Issues')).resolves.toEqual({ content: '2 PRs & Issues' });
        await expect(control.queryByText('First')).resolves.toBeUndefined();
    });

    it('says the many-count in the reader own language', async () => {
        const control = await mountControl({
            attachments: [
                attachmentView({ instanceId: 'a1', label: 'First', entryId: '42' }),
                attachmentView({ instanceId: 'a2', label: 'Second', entryId: '43' }),
            ],
            // A host catalog entry, not this plugin's shipped copy: the case
            // proves the label is RESOLVED rather than assembled in English, and
            // pinning the shipped sentence would prove neither.
            translations: { 'plugins.triage.composer.entriesCount': 'fixture:{count} entrees' },
        });

        await expect(control.getByText('fixture:2 entrees')).resolves
            .toEqual({ content: 'fixture:2 entrees' });
    });

    it('counts only its own contribution inside a shared snapshot', async () => {
        const control = await mountControl({
            attachments: [
                attachmentView({ instanceId: 'a1', label: 'Mine', entryId: '42' }),
                attachmentView({
                    instanceId: 'b1',
                    label: 'Someone else',
                    entryId: '99',
                    attachment: { pluginId: 'happier.notes', localId: 'note' },
                }),
            ],
        });

        // One, not two: another plugin's attachment lives in the same snapshot.
        await expect(control.getByText('Mine')).resolves.toEqual({ content: 'Mine' });
    });

    it('falls back to the plain title when the composer cannot be read', async () => {
        const control = await mountControl({ unavailable: true });

        // Truthfully the zero state, never a remembered count: the addressed
        // scope is gone and the draft it described no longer exists.
        await expect(control.getByText('PRs & Issues')).resolves.toEqual({ content: 'PRs & Issues' });
    });

    it('renders nothing but the plain title when it was not mounted on its own control', async () => {
        const control = await mountControl({
            attachments: [attachmentView({ instanceId: 'a1', label: 'Not mine', entryId: '42' })],
            launchInput: {
                v: 1,
                role: 'controlCompact',
                composer: SESSION_COMPOSER,
                controlLocalId: 'someone-elses-control',
                state: {},
            },
        });

        // The composer would read perfectly well; the mount is simply not this
        // contribution's, so reading it would be reading a draft on behalf of a
        // control that is not ours.
        await expect(control.getByText('PRs & Issues')).resolves.toEqual({ content: 'PRs & Issues' });
        await expect(control.queryByText('Not mine')).resolves.toBeUndefined();
    });
});
