import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

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
    declarativeInventory: Object.freeze({
        actions: Object.freeze([]),
        destinations: Object.freeze([]),
        settings: Object.freeze([]),
        uiQueries: Object.freeze([]),
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
    it('forwards rejected Composer settlement through the shared pressable and clears pending safely', async () => {
        let rejectApply!: (error: Error) => void;
        const rejectedApply = new Promise<never>((_resolve, reject) => {
            rejectApply = reject;
        });
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
        process.on('unhandledRejection', onUnhandled);
        try {
            const screen = await renderScreen(
                <DeclarativePluginSurface
                    {...({
                        pluginId: 'acme.composer',
                        model,
                        interactionEnabled: true,
                        daemonInteractionEnabled: false,
                        dispatchAction: vi.fn(),
                        actionAvailable: false,
                        openSurface: async () => null,
                        openSurfaceAvailable: false,
                        authorityGeneration: 1,
                        composerRef: Object.freeze({ kind: 'session' as const, sessionId: 'session-composer-rejection' }),
                        applyComposer: vi.fn(() => rejectedApply),
                        composerApplyAvailable: true,
                    } as unknown as React.ComponentProps<typeof DeclarativePluginSurface>)}
                />,
            );
            const pressable = screen.findAllByType(HappierPressable).find((candidate) => (
                candidate.props.testID === 'plugin-declarative-action:composerApply:root'
            ));
            if (!pressable) throw new Error('missing_composer_apply_pressable');

            let settlement!: Promise<void>;
            await act(async () => {
                settlement = pressable.props.onPress();
                await Promise.resolve();
            });
            expect(settlement).toEqual(expect.objectContaining({ then: expect.any(Function) }));
            expect(screen.findAllByType(HappierPressable).find((candidate) => (
                candidate.props.testID === 'plugin-declarative-action:composerApply:root'
            ))?.props.busy).toBe(true);

            rejectApply(new Error('composer_apply_failed'));
            await act(async () => {
                await settlement;
                await new Promise((resolve) => setTimeout(resolve, 0));
            });

            expect(unhandled).toEqual([]);
            const settledPressable = screen.findAllByType(HappierPressable).find((candidate) => (
                candidate.props.testID === 'plugin-declarative-action:composerApply:root'
            ));
            expect(settledPressable?.props.busy).toBe(false);
        } finally {
            process.off('unhandledRejection', onUnhandled);
        }
    });

    it('forwards rejected Action settlement through the shared pressable and clears pending safely', async () => {
        let rejectAction!: (error: Error) => void;
        const rejectedAction = new Promise<never>((_resolve, reject) => {
            rejectAction = reject;
        });
        const actionModel = Object.freeze({
            ...model,
            identity: Object.freeze({
                pluginId: 'acme.composer',
                localId: 'actions',
                qualifiedId: 'acme.composer/actions',
                generation: 'composer-generation',
            }),
            declarativeInventory: Object.freeze({
                ...model.declarativeInventory,
                actions: Object.freeze([Object.freeze({
                    identity: Object.freeze({ pluginId: 'acme.composer', localId: 'run' }),
                    qualifiedId: 'acme.composer/run',
                    generation: 'composer-generation',
                    enabled: true,
                    title: 'Run action',
                })]),
            }),
            root: Object.freeze({
                kind: 'action',
                path: 'root',
                order: 0,
                label: 'Run action',
                enabled: true,
                action: Object.freeze({
                    identity: Object.freeze({ pluginId: 'acme.composer', localId: 'run' }),
                    qualifiedId: 'acme.composer/run',
                    generation: 'composer-generation',
                }),
            }),
        });
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
        process.on('unhandledRejection', onUnhandled);
        try {
            const screen = await renderScreen(
                <DeclarativePluginSurface
                    {...({
                        pluginId: 'acme.composer',
                        model: actionModel,
                        interactionEnabled: true,
                        daemonInteractionEnabled: true,
                        dispatchAction: vi.fn(() => rejectedAction),
                        actionAvailable: true,
                        openSurface: async () => null,
                        openSurfaceAvailable: false,
                        authorityGeneration: 1,
                    } as unknown as React.ComponentProps<typeof DeclarativePluginSurface>)}
                />,
            );
            const pressable = screen.findAllByType(HappierPressable).find((candidate) => (
                candidate.props.testID === 'plugin-declarative-action:acme.composer/run'
            ));
            if (!pressable) throw new Error('missing_action_pressable');

            let settlement!: Promise<void>;
            await act(async () => {
                settlement = pressable.props.onPress();
                await Promise.resolve();
            });
            expect(settlement).toEqual(expect.objectContaining({ then: expect.any(Function) }));
            expect(screen.findAllByType(HappierPressable).find((candidate) => (
                candidate.props.testID === 'plugin-declarative-action:acme.composer/run'
            ))?.props.busy).toBe(true);

            rejectAction(new Error('action_failed'));
            await act(async () => {
                await settlement;
                await new Promise((resolve) => setTimeout(resolve, 0));
            });

            expect(unhandled).toEqual([]);
            const settledPressable = screen.findAllByType(HappierPressable).find((candidate) => (
                candidate.props.testID === 'plugin-declarative-action:acme.composer/run'
            ));
            expect(settledPressable?.props.busy).toBe(false);
        } finally {
            process.off('unhandledRejection', onUnhandled);
        }
    });

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

    it('copies and deeply freezes nested authored transaction values before retaining them', async () => {
        const authoredValue = { issue: { id: 'INC-42' } };
        const authoredOperation = {
            kind: 'attachment.add' as const,
            attachmentLocalId: 'incident',
            value: {
                key: 'incident-42',
                value: authoredValue,
                presentation: { label: 'Incident 42' },
            },
        };
        const applyComposer = vi.fn<BoundPluginSurfaceController['applyComposer']>(
            async () => ({ status: 'applied' as const, revision: 6 }),
        );
        const composerRef = Object.freeze({ kind: 'session' as const, sessionId: 'session-composer-mounted' });
        const nestedModel = {
            ...model,
            root: {
                ...model.root,
                effect: {
                    kind: 'composerApply' as const,
                    expectedRevision: 5,
                    operations: [authoredOperation],
                },
            },
        };
        const screen = await renderScreen(
            <DeclarativePluginSurface
                {...({
                    pluginId: 'acme.composer',
                    model: nestedModel,
                    interactionEnabled: true,
                    daemonInteractionEnabled: false,
                    dispatchAction: vi.fn(),
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

        await act(async () => {
            screen.pressByTestId('plugin-declarative-action:composerApply:root');
        });

        const transaction = applyComposer.mock.calls[0]?.[1];
        expect(transaction).toEqual({ expectedRevision: 5, operations: [authoredOperation] });
        expect(transaction?.operations).not.toBe(nestedModel.root.effect.operations);
        expect(transaction?.operations[0]).not.toBe(authoredOperation);
        expect((transaction?.operations[0] as typeof authoredOperation).value.value).not.toBe(authoredValue);
        expect(Object.isFrozen(transaction)).toBe(true);
        expect(Object.isFrozen(transaction?.operations)).toBe(true);
        expect(Object.isFrozen(transaction?.operations[0])).toBe(true);
        expect(Object.isFrozen((transaction?.operations[0] as typeof authoredOperation).value.value.issue)).toBe(true);
    });
});
