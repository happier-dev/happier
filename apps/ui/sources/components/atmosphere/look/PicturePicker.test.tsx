import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ATMOSPHERE_PICTURES } from '@happier-dev/brand/atmosphere';
import { createDeferred, renderScreen, standardCleanup } from '@/dev/testkit';
import { Modal } from '@/modal';
import { t } from '@/text';
import { pictureStore } from '../pictureStore';
import { PicturePicker } from './PicturePicker';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { nativePickImages } from '@/utils/files/nativePickImages';
import { PictureControls } from './LookControls';
import { DEFAULT_HOME_ATMOSPHERE, atmospherePresentation } from '@happier-dev/protocol/account/settings/accountSettings';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';

// The device's OS picker is the acquisition boundary; Actions and image ingress stay real.
vi.mock('@/utils/files/nativePickImages', () => ({ nativePickImages: vi.fn(async () => []) }));

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async importOriginal => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
    return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});
installDisconnectedServerSocketBoundary();

vi.mock('@/components/atmosphere/pictureStore', async () => import('../pictureStore.web'));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

describe('the Look panel picker keeps its controls in view', () => {
    afterEach(() => { standardCleanup(); vi.restoreAllMocks(); });
    const tileIds = (screen: Awaited<ReturnType<typeof renderScreen>>) => [...new Set(screen.tree.root
        .findAll((node) => typeof node.props.testID === 'string' && node.props.testID.startsWith('atmosphere-picture:'))
        .map((node) => node.props.testID as string))];

    it('shows two rows with the chosen picture in view, then opens the whole gallery in place', async () => {
        const pictures = ATMOSPHERE_PICTURES.slice(0, 10);
        const chosen = pictures[8]!;
        const screen = await renderScreen(<PicturePicker pictures={pictures} collapsedCount={6} columns={4}
            selected={{ kind: 'builtin', id: chosen.id }} onSelect={vi.fn()} />);
        const shown = tileIds(screen);
        expect(shown).toEqual([
            ...pictures.slice(0, 5).map((picture) => `atmosphere-picture:${picture.id}`),
            `atmosphere-picture:${chosen.id}`,
            'atmosphere-picture:add-your-picture',
            'atmosphere-picture:more-pictures',
        ]);
        await screen.pressByTestIdAsync('atmosphere-picture:more-pictures');
        expect(tileIds(screen)).toEqual([
            ...pictures.map((picture) => `atmosphere-picture:${picture.id}`),
            'atmosphere-picture:add-your-picture',
        ]);
        await screen.unmount();
    });
});

describe('picture credit and remove interactions', () => {
    beforeEach(() => vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 }))));
    afterEach(() => { standardCleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

    it('honors Settings Action Off and canceled Ask before opening the OS picker or storing/selecting bytes', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({ actionsSettingsV1: {
            v: 1, actions: { 'settings.invoke': { disabledSurfaces: ['ui'] } },
        } }) });
        const selected = vi.fn();
        const before = await pictureStore.list();
        vi.mocked(nativePickImages).mockClear();
        try {
            const screen = await renderScreen(<PicturePicker pictures={[]} selected={null} onSelect={selected} />);
            await screen.pressByTestIdAsync('atmosphere-picture:add-your-picture');
            await act(async () => {});
            expect(nativePickImages).not.toHaveBeenCalled();
            expect(await pictureStore.list()).toEqual(before);
            expect(selected).not.toHaveBeenCalled();
            expect(account.settingsWrites).toEqual([]);
            await act(async () => { account.replaceSettings(settingsParse({ actionsSettingsV1: {
                v: 1, actions: { 'settings.invoke': { approvalRequiredSurfaces: ['ui'] } },
            } })); });
            await screen.pressByTestIdAsync('atmosphere-picture:add-your-picture');
            // Explicit Ask uses the canonical retained approval, rather than a local confirm dialog.
            await act(async () => {
                await vi.waitFor(() => expect(account.artifacts.list()).toHaveLength(1));
            });
            const approvalId = account.artifacts.list()[0]!.id;
            const readApproval = () => ApprovalRequestV2Schema.parse(JSON.parse(account.artifacts.readPlainBody(approvalId)!));
            expect(readApproval()).toMatchObject({ actionId: 'settings.invoke', status: 'open' });
            expect(nativePickImages).not.toHaveBeenCalled();
            expect(await pictureStore.list()).toEqual(before);
            expect(selected).not.toHaveBeenCalled();
            expect(account.settingsWrites).toEqual([]);
            expect(await decideApprovalAsInbox(account.scope.serverId, approvalId, 'cancel')).toMatchObject({ ok: true });
            await vi.waitFor(() => expect(readApproval()).toMatchObject({ status: 'canceled' }));
            expect(nativePickImages).not.toHaveBeenCalled();
            expect(await pictureStore.list()).toEqual(before);
            await screen.unmount();
        } finally { await account.dispose(); }
    });

    it('acquires through the real contextual Look controls into only the captured profile draft', async () => {
        const account = await createSecretSettingsTestHarness();
        const initialHome = account.persistedSettings.homeAtmosphere;
        let draft = atmospherePresentation({ ...DEFAULT_HOME_ATMOSPHERE, source: 'none' });
        vi.mocked(nativePickImages).mockResolvedValueOnce([{ kind: 'web', file: new File(['pixels'], 'photo.png', { type: 'image/png' }) }]);
        vi.stubGlobal('createImageBitmap', async () => ({ width: 16, height: 8, close() {} }));
        vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage() {} }),
            toBlob: (done: (blob: Blob) => void) => done(new Blob(['prepared-profile'], { type: 'image/webp' })) }) });
        const update = (edit: (value: typeof draft) => typeof draft) => { draft = edit(draft); };
        try {
            const screen = await renderScreen(<PictureControls presentation="panel" pictures={[]} editor={{ value: draft,
                update: () => { throw new Error('Acquisition must select through its captured Settings owner'); },
                pictureActions: { target: { kind: 'public_profile_draft', serverId: account.scope.serverId }, executorOptions: {
                    publicProfileAtmosphereDraft: { serverId: account.scope.serverId, isCurrent: () => true, read: () => draft, update },
                } },
            }} />);
            await screen.pressByTestIdAsync('atmosphere-picture:add-your-picture');
            await vi.waitFor(() => expect(draft.picture.ref.kind).toBe('user'));
            expect(draft.source).toBe('picture');
            if (draft.picture.ref.kind !== 'user') throw new Error('Profile did not select acquired bytes');
            const record = await pictureStore.get(draft.picture.ref.localId);
            expect(record?.kind).toBe('user');
            expect(record?.data).toBeInstanceOf(Blob);
            if (!(record?.data instanceof Blob)) throw new Error('Device bytes missing');
            expect(await record.data.text()).toBe('prepared-profile');
            expect(account.persistedSettings.homeAtmosphere).toEqual(initialHome);
            expect(account.settingsWrites).toEqual([]);
            await screen.unmount();
            await pictureStore.remove(draft.picture.ref.localId);
        } finally { await account.dispose(); }
    });

    it('keeps omitted-target acquisition at the declared Home owner', async () => {
        const account = await createSecretSettingsTestHarness();
        const selected = vi.fn();
        vi.mocked(nativePickImages).mockResolvedValueOnce([{ kind: 'web', file: new File(['pixels'], 'photo.png', { type: 'image/png' }) }]);
        vi.stubGlobal('createImageBitmap', async () => ({ width: 16, height: 8, close() {} }));
        vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage() {} }),
            toBlob: (done: (blob: Blob) => void) => done(new Blob(['prepared-home'], { type: 'image/webp' })) }) });
        try {
            const screen = await renderScreen(<PicturePicker pictures={[]} selected={null} onSelect={selected} />);
            await screen.pressByTestIdAsync('atmosphere-picture:add-your-picture');
            await vi.waitFor(() => expect(account.persistedSettings.homeAtmosphere.picture.ref.kind).toBe('user'));
            expect(account.persistedSettings.homeAtmosphere.source).toBe('picture');
            // Acquisition already selected through the declaration; never replay a render-time editor write.
            expect(selected).not.toHaveBeenCalled();
            await screen.unmount();
            const ref = account.persistedSettings.homeAtmosphere.picture.ref;
            if (ref.kind === 'user') await pictureStore.remove(ref.localId);
        } finally { await account.dispose(); }
    });

    it('discards an outstanding OS picker result after unmount before image preparation or writes', async () => {
        const account = await createSecretSettingsTestHarness();
        const picked = createDeferred<Awaited<ReturnType<typeof nativePickImages>>>();
        vi.mocked(nativePickImages).mockClear().mockReturnValueOnce(picked.promise);
        const decode = vi.fn();
        vi.stubGlobal('createImageBitmap', decode);
        const before = await pictureStore.list();
        const selected = vi.fn();
        try {
            const screen = await renderScreen(<PicturePicker pictures={[]} selected={null} onSelect={selected} />);
            await screen.pressByTestIdAsync('atmosphere-picture:add-your-picture');
            await vi.waitFor(() => expect(nativePickImages).toHaveBeenCalled());
            await screen.unmount();
            await act(async () => { picked.resolve([{ kind: 'web', file: new File(['pixels'], 'photo.png', { type: 'image/png' }) }]); });
            expect(decode).not.toHaveBeenCalled();
            expect(await pictureStore.list()).toEqual(before);
            expect(selected).not.toHaveBeenCalled();
            expect(account.settingsWrites).toEqual([]);
        } finally { await account.dispose(); }
    });

    it('exposes a named, keyboard-focusable credit link through the interaction owner', async () => {
        const picture = ATMOSPHERE_PICTURES[0];
        const screen = await renderScreen(<PicturePicker pictures={[picture]} selected={{ kind: 'builtin', id: picture.id }} onSelect={() => {}} />);
        const link = screen.findByTestId('atmosphere-picture-credit');
        expect(link?.props.accessibilityRole).toBe('link');
        expect(link?.props.accessibilityLabel).toContain(picture.title);
        expect(link?.props.onFocus).toBeTypeOf('function');
        expect(link?.props.onBlur).toBeTypeOf('function');
        await screen.unmount();
    });

    it('admits picture removal through Actions and honors a waiver without a second confirmation', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({ actionsSettingsV1: {
            v: 1, actions: { 'settings.invoke': { disabledSurfaces: ['ui'] } },
        } }) });
        const localId = 'picker-remove-contract';
        await pictureStore.put({ localId, kind: 'user', data: new Blob(['pixels'], { type: 'image/webp' }) });
        const confirm = vi.spyOn(Modal, 'confirm').mockResolvedValue(false);
        try {
            const screen = await renderScreen(<PicturePicker pictures={[]} selected={{ kind: 'user', localId }} onSelect={() => {}} />);
            await vi.waitFor(async () => { await act(async () => {}); expect(screen.findByTestId('atmosphere-picture-remove')).not.toBeNull(); });
            const button = screen.findByTestId('atmosphere-picture-remove')!;
            expect(button.props.accessibilityLabel).toBe(t('settingsAppearance.glassControls.atmospherePictureRemove'));
            await act(async () => { await button.props.onPress(); });
            expect(confirm).not.toHaveBeenCalled();
            expect(await pictureStore.get(localId)).toBeDefined();
            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings,
                actionsSettingsV1: { v: 1 },
            })); });
            await act(async () => { await screen.findByTestId('atmosphere-picture-remove')!.props.onPress(); });
            expect(confirm).toHaveBeenCalledTimes(1);
            expect(await pictureStore.get(localId)).toBeDefined();
            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings, actionsSettingsV1: {
                v: 1, approvalWaivedSurfaces: { 'settings.invoke': ['ui'] },
            } })); });
            await act(async () => {
                await screen.findByTestId('atmosphere-picture-remove')!.props.onPress();
                await vi.waitFor(async () => expect(await pictureStore.get(localId)).toBeUndefined());
            });
            expect(confirm).toHaveBeenCalledTimes(1);
            await screen.unmount();
        } finally { await account.dispose(); }
    });
});
