import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it } from 'vitest';
import { CompositionStrip } from '@happier-dev/plugin-ui/presentation';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { preloadTranslationsForSettings, setPreferredLanguageFromSettings, t } from '@/text';

import { StorageVolumeRow, StorageVolumes } from './StorageVolumes';
import type { StorageSummary, StorageVolume } from './storageViewModel';

afterEach(() => {
    standardCleanup();
    setPreferredLanguageFromSettings('en');
});

it('renders exclusive cleanup and Trash gains while keeping allocated bytes in the legend', async () => {
    const volume = { volume: { volumeId: 'disk', mountPath: '/', label: 'Disk' }, totalBytes: 1_000_000,
        freeBytes: 500_000, happierBytes: 40_960, pileBytes: 20_480, trashBytes: 0, pileFreesBytes: 4_096, trashFreesBytes: 0 };
    const screen = await renderScreen(<StorageVolumeRow volume={volume} compact={false} />);
    expect(screen.getTextContent()).toContain(t('machineStorage.volumes.afterCleanupGain', { amount: '4.1 KB' }));
    expect(screen.getTextContent()).toContain('20.5 KB');
    await screen.update(<StorageVolumeRow volume={{ ...volume, pileBytes: 0, pileFreesBytes: 0, trashBytes: 20_480, trashFreesBytes: 4_096 }} compact={false} />);
    expect(screen.getTextContent()).toContain(t('machineStorage.volumes.afterTrashEmpties'));
    expect(screen.getTextContent()).toContain(t('machineStorage.volumes.afterCleanupGain', { amount: '4.1 KB' }));
});

it('updates mounted capacity legends on a committed language change with unchanged volume data', async () => {
    setPreferredLanguageFromSettings('en');
    const volume: StorageVolume = {
        volume: { volumeId: 'disk', mountPath: '/', label: '/' },
        totalBytes: 1_000_000_000, freeBytes: 400_000_000, happierBytes: 100_000_000,
        pileBytes: 20_000_000, pileFreesBytes: 20_000_000, trashBytes: 0,
    };
    const emptyVolume: StorageVolume = { ...volume, volume: { volumeId: 'empty', mountPath: '/mnt/empty', label: 'Empty' }, happierBytes: 0, pileBytes: 0 };
    const screen = await renderScreen(<>
        <StorageVolumeRow volume={volume} compact={false} />
        <StorageVolumeRow volume={emptyVolume} compact={false} />
    </>);
    const row = screen.findByTestId('machine-storage-volume-disk');
    const keys = ['machineStorage.volumes.everythingElse', 'machineStorage.volumes.free', 'machineStorage.volumes.inPile', 'machineStorage.volumes.nothingOfHappier', 'machineStorage.volumes.systemDisk'] as const;
    const previous = keys.map(key => t(key));
    for (const label of previous) expect(screen.getTextContent()).toContain(label);

    await act(async () => {
        await preloadTranslationsForSettings('fr');
        setPreferredLanguageFromSettings('fr');
    });

    for (const key of keys) expect(screen.getTextContent()).toContain(t(key));
    for (const label of previous) expect(screen.getTextContent()).not.toContain(label);
    expect(screen.findByTestId('machine-storage-volume-disk')).toBe(row);
});

it('shows sampled reclaimable capacity quietly in the bar, preserving the free-now and cleanup figures', async () => {
    const volume: StorageVolume = {
        volume: { volumeId: 'disk', mountPath: '/', label: 'Macintosh HD' }, totalBytes: 1000, freeBytes: 100,
        availableIncludingPurgeableBytes: 350, happierBytes: 200, pileBytes: 20, pileFreesBytes: 20, trashBytes: 0,
    };
    const screen = await renderScreen(<StorageVolumeRow volume={volume} compact={false} />);
    // The React renderer erases props; this exact component query supplies its public prop contract.
    const bar = () => screen.findAllByType(CompositionStrip).find(node => node.props.variant === 'bar')!.props as React.ComponentProps<typeof CompositionStrip>;
    expect(bar().segments).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'purgeable', value: 250 }), expect.objectContaining({ id: 'free', value: 100 }),
    ]));
    expect(bar().segments.reduce((sum, segment) => {
        if (segment.value === null) throw new Error('Every drawn capacity segment must have a measured value');
        return sum + segment.value;
    }, 0)).toBe(1000);
    expect(screen.getTextContent()).toContain(t('machineStorage.volumes.purgeable'));
    expect(screen.getTextContent()).toContain(t('machineStorage.volumes.afterCleanupFree', { free: '120 B' }));
    await screen.update(<StorageVolumeRow volume={{ ...volume, availableIncludingPurgeableBytes: volume.freeBytes }} compact={false} />);
    expect(bar().segments.some((segment: { id: string }) => segment.id === 'purgeable')).toBe(false);
    const { availableIncludingPurgeableBytes: _known, ...unknown } = volume;
    await screen.update(<StorageVolumeRow volume={unknown} compact={false} />);
    expect(bar().segments.some((segment: { id: string }) => segment.id === 'purgeable')).toBe(false);
});

it('keeps the owner\'s system partitions out of the disk section and says why a disk cannot be cleaned', async () => {
    const disk = (volumeId: string, mountPath: string, cleanup?: StorageVolume['cleanup'], happierBytes = 0): StorageVolume => ({ volume: { volumeId, mountPath, label: mountPath },
        totalBytes: 1_000_000, freeBytes: 500_000, happierBytes, pileBytes: 0, trashBytes: 0, ...(cleanup ? { cleanup } : {}) });
    const summary = { volumes: [
        disk('root', '/', { kind: 'available' }, 40_960),
        disk('boot', '/boot', { kind: 'unavailable', reason: 'system_partition' }),
        disk('efi', '/boot/efi', { kind: 'unavailable', reason: 'system_partition' }),
        disk('data', '/srv/data', { kind: 'unavailable', reason: 'permission_denied' }),
        disk('ro', '/mnt/ro', { kind: 'unavailable', reason: 'read_only' }),
        disk('old', '/mnt/old'),
    ] } as unknown as StorageSummary;
    const screen = await renderScreen(<StorageVolumes summary={summary} compact={false} />);
    for (const id of ['root', 'data', 'ro', 'old']) expect(screen.findAllHostsByTestId(`machine-storage-volume-${id}`)).not.toHaveLength(0);
    expect(screen.findAllHostsByTestId('machine-storage-volume-boot')).toHaveLength(0);
    expect(screen.findAllHostsByTestId('machine-storage-volume-efi')).toHaveLength(0);
    expect(screen.findAllHostsByTestId('machine-storage-volume-data-cleanup')).not.toHaveLength(0);
    expect(screen.getTextContent()).toContain(t('machineStorage.volumes.cleanupUnavailable.permission_denied'));
    expect(screen.getTextContent()).toContain(t('machineStorage.volumes.cleanupUnavailable.read_only'));
    expect(screen.findAllHostsByTestId('machine-storage-volume-root-cleanup')).toHaveLength(0);
    expect(screen.findAllHostsByTestId('machine-storage-volume-old-cleanup')).toHaveLength(0);
});
