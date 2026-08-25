import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { standardCleanup } from '@/dev/testkit';

import {
    renderNewSessionScreenModel,
    resetDraftPersistenceState,
    searchParamsState,
    useCreateNewSessionArgsRef,
} from './__tests__/draftPersistenceTestEnvironment';

/**
 * Machine-id-domain draft-persistence behavior. Currently this suite covers
 * the route-driven machine swap; expand here for additional machine-id
 * specific draft behaviors as they're added.
 */
describe('useNewSessionScreenModel (draft hydration — machine)', () => {
    afterEach(() => {
        standardCleanup();
    });

    beforeEach(async () => {
        await resetDraftPersistenceState();
    });

    it('clears stale workspace linkage after the selected machine changes to a different machine route', async () => {
        let model: any = null;
        const hook = await renderNewSessionScreenModel((nextModel) => {
            model = nextModel;
        });

        searchParamsState.value = {
            machineId: 'machine-1',
        };

        await hook.rerender();

        expect(model?.simpleProps?.machineName).toBe('Machine One');
        expect(model?.simpleProps?.selectedPath).toBe('/home/one');
        expect(model?.simpleProps?.selectedWorkspaceId).toBeUndefined();
        expect(model?.simpleProps?.selectedWorkspaceLocationId).toBeUndefined();
        expect(model?.simpleProps?.selectedWorkspaceCheckoutId).toBeUndefined();
        expect(useCreateNewSessionArgsRef.current).toEqual(expect.objectContaining({
            authoringDraft: expect.objectContaining({
                directory: '/home/one',
            }),
        }));
    });
});
