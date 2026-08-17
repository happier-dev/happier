import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type { BoundPluginSurfaceController } from './boundPluginSurfaceController';
import { DeclarativePluginSurface } from './DeclarativePluginSurface';
import { renderScreen } from '@/dev/testkit';

const model = Object.freeze({
    visible: true,
    identity: Object.freeze({
        pluginId: 'acme.composer',
        localId: 'incident-tools',
        qualifiedId: 'acme.composer/incident-tools',
        generation: 'composer-generation',
    }),
    root: Object.freeze({
        kind: 'action',
        path: 'root',
        order: 0,
        label: 'Replace draft',
        enabled: true,
        effect: Object.freeze({
            kind: 'composerApply',
            expectedRevision: 4,
            operations: Object.freeze([{ kind: 'text.set', text: 'Triage this incident' }]),
        }),
    }),
});

describe('DeclarativePluginSurface composerApply', () => {
    it('uses the mounted composer facade even while daemon Actions are unavailable', async () => {
        const dispatchAction = vi.fn<BoundPluginSurfaceController['dispatchAction']>();
        const applyComposer = vi.fn(async () => ({ status: 'applied' as const, revision: 5 }));
        const composerRef = Object.freeze({ kind: 'session' as const, sessionId: 'session-composer-mounted' });
        const screen = await renderScreen(
            <DeclarativePluginSurface
                {...({
                    pluginId: 'acme.composer',
                    model,
                    interactionEnabled: true,
                    daemonInteractionEnabled: false,
                    dispatchAction,
                    actionAvailable: false,
                    openSurface: async () => null,
                    openSurfaceAvailable: false,
                    authorityGeneration: 1,
                    composerRef,
                    applyComposer,
                    composerApplyAvailable: true,
                } as unknown as React.ComponentProps<typeof DeclarativePluginSurface>)}
            />,
        );

        expect(screen.findByTestId('plugin-declarative-action:composerApply:root')?.props.disabled).toBe(false);
        await act(async () => {
            screen.pressByTestId('plugin-declarative-action:composerApply:root');
        });

        expect(applyComposer).toHaveBeenCalledExactlyOnceWith(composerRef, {
            expectedRevision: 4,
            operations: [{ kind: 'text.set', text: 'Triage this incident' }],
        });
        expect(dispatchAction).not.toHaveBeenCalled();
    });
});
