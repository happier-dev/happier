import * as React from 'react';
import { View } from 'react-native';
import { isHappierRuntimePathWithinRoot } from '@happier-dev/cli-common/happierRuntime/runtimePathMatching';
import { Modal, type CustomModalInjectedProps } from '@/modal';
import { createDeferredOnce } from '@/modal/async/createDeferredOnce';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import type { SystemTaskPromptContinuation, SystemTaskRunner } from '@/components/systemTasks/types';
import { disconnectThisComputerBeforeForgettingHome } from '@/components/serverProfiles/disconnectThisComputerFromHome';
import { toServerUrlDisplay } from '@/sync/domains/server/url/serverUrlDisplay';
import { formatByteSize } from '@/utils/files/formatByteSize';
import { t, tLoose } from '@/text';

function formatBytes(bytes: number | null): string {
    return bytes == null ? t('personalHome.settings.unknownSize') : formatByteSize(bytes);
}

type PersonalHomeErasePreviewProps = CustomModalInjectedProps & Readonly<{
    canonicalServerUrl: string;
    homeServerIdentityId: string | null;
    paths: readonly string[];
    estimatedBytes: number | null;
    onConfirm: () => void;
    onCancel: () => void;
}>;

function pathLeaf(path: string): string {
    return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

const PersonalHomeErasePreview = React.memo(function PersonalHomeErasePreview(
    props: PersonalHomeErasePreviewProps,
) {
    const resolve = (confirmed: boolean) => {
        if (confirmed) props.onConfirm();
        else props.onCancel();
        props.onClose();
    };
    return <View testID="settings.personalHomeRuntime.erasePreview" style={{ gap: 12 }}>
        <ItemGroup>
            <Item testID="settings.personalHomeRuntime.erasePreviewHome" title={t('personalHome.settings.eraseHomeTarget')} subtitle={props.canonicalServerUrl} subtitleLines={0} showChevron={false} mode="info" />
            <Item testID="settings.personalHomeRuntime.erasePreviewIdentity" title={t('personalHome.settings.identityTitle')} subtitle={props.homeServerIdentityId ?? t('personalHome.settings.identityUnavailable')} subtitleLines={0} showChevron={false} mode="info" />
            <Item testID="settings.personalHomeRuntime.erasePreviewSize" title={t('personalHome.settings.estimatedSize')} subtitle={formatBytes(props.estimatedBytes)} showChevron={false} mode="info" />
        </ItemGroup>
        <ItemGroup title={t('personalHome.settings.eraseDataBody')}>
            {props.paths.map((path, index) => <Item key={path} testID={`settings.personalHomeRuntime.erasePreviewPath.${index}`} title={pathLeaf(path)} subtitle={path} subtitleLines={0} showChevron={false} mode="info" />)}
        </ItemGroup>
        <ItemGroup>
            <Item testID="settings.personalHomeRuntime.erasePreviewCancel" title={t('common.cancel')} onPress={() => resolve(false)} />
            <Item testID="settings.personalHomeRuntime.erasePreviewConfirm" title={tLoose('common.delete')} onPress={() => resolve(true)} destructive />
        </ItemGroup>
    </View>;
});

async function confirmPersonalHomeErasePreview(input: Readonly<{
    canonicalServerUrl: string;
    homeServerIdentityId: string | null;
    paths: readonly string[];
    estimatedBytes: number | null;
}>): Promise<boolean> {
    const deferred = createDeferredOnce<boolean>();
    Modal.show({
        component: PersonalHomeErasePreview,
        props: {
            ...input,
            onConfirm: () => deferred.resolve(true),
            onCancel: () => deferred.resolve(false),
        },
        onRequestClose: () => deferred.resolve(false),
        chrome: {
            kind: 'card',
            title: t('personalHome.settings.eraseDataTitle'),
            bodyScroll: 'auto',
            dimensions: { width: 520, maxHeightRatio: 0.85, size: 'md' },
            testID: 'settings.personalHomeRuntime.erasePreviewModal',
        },
        closeOnBackdrop: true,
    });
    return await deferred.promise;
}

export function createPersonalHomeErasePreviewContinuation(input: Readonly<{
    verifiedBackupHomeServerIdentityId?: string | null;
    verifiedBackupPath?: string | null;
}> = {}): SystemTaskPromptContinuation {
    const verifiedBackupHomeServerIdentityId = input.verifiedBackupHomeServerIdentityId ?? null;
    const verifiedBackupPath = input.verifiedBackupPath ?? null;
    return async (prompt) => {
        if (prompt.kind !== 'personal_home.confirm_erase.v1') return undefined;
        const rawPaths = prompt.data.paths;
        const paths = Array.isArray(rawPaths)
            ? rawPaths.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
            : [];
        const estimatedBytes = typeof prompt.data.estimatedBytes === 'number'
            && Number.isFinite(prompt.data.estimatedBytes) && prompt.data.estimatedBytes >= 0
            ? prompt.data.estimatedBytes : null;
        const canonicalServerUrl = typeof prompt.data.canonicalServerUrl === 'string'
            ? prompt.data.canonicalServerUrl.trim() : '';
        const homeServerIdentityId = prompt.data.homeServerIdentityId === null
            || (typeof prompt.data.homeServerIdentityId === 'string' && prompt.data.homeServerIdentityId.trim().length > 0)
            ? prompt.data.homeServerIdentityId : undefined;
        if (!Array.isArray(rawPaths) || paths.length === 0 || paths.length !== rawPaths.length
            || !canonicalServerUrl || homeServerIdentityId === undefined
            || prompt.data.previewComplete !== true || prompt.data.previewReason !== null) return { confirmed: false };
        if (verifiedBackupHomeServerIdentityId !== null
            && homeServerIdentityId !== verifiedBackupHomeServerIdentityId) return { confirmed: false };
        if (verifiedBackupPath !== null
            && paths.some((ownedPath) => isHappierRuntimePathWithinRoot(verifiedBackupPath, ownedPath))) {
            return { confirmed: false };
        }
        const confirmed = await confirmPersonalHomeErasePreview({
            canonicalServerUrl,
            homeServerIdentityId,
            paths,
            estimatedBytes,
        });
        return { confirmed };
    };
}

export function withPersonalHomeEraseDisconnect(
    runner: SystemTaskRunner,
    continuation: SystemTaskPromptContinuation,
    onConfirmedIdentity?: (identity: string | null) => void,
): SystemTaskPromptContinuation {
    return async prompt => {
        const answer = await continuation(prompt);
        if (prompt.kind !== 'personal_home.confirm_erase.v1' || !answer || typeof answer !== 'object'
            || !('confirmed' in answer) || answer.confirmed !== true) return answer;
        const serverUrl = typeof prompt.data.canonicalServerUrl === 'string' ? prompt.data.canonicalServerUrl.trim() : '';
        if (!serverUrl) return { confirmed: false };
        const identity = typeof prompt.data.homeServerIdentityId === 'string' ? prompt.data.homeServerIdentityId.trim() || null : null;
        onConfirmedIdentity?.(identity);
        const mayErase = await disconnectThisComputerBeforeForgettingHome({
            serverUrl, serverIdentityId: identity, label: toServerUrlDisplay(serverUrl),
        }, runner);
        return mayErase ? answer : { confirmed: false };
    };
}
