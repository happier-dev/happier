import * as React from 'react';
import { View } from 'react-native';
import { Octicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { Modal } from '@/modal';
import { scmStatusSync } from '@/scm/scmStatusSync';
import { sessionScmRepositoryInit } from '@/sync/ops/sessions';
import { SourceControlUpdateButton } from '@/components/sessions/sourceControl/update/SourceControlUpdateControls';

export function NotSourceControlRepositoryState(props: Readonly<{
    sessionId?: string;
    canInitializeRepository?: boolean;
    onInitialized?: () => void | Promise<void>;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const [busy, setBusy] = React.useState(false);

    const canInitialize =
        typeof props.sessionId === 'string'
        && props.sessionId.length > 0
        && props.canInitializeRepository === true;

    const initializeRepository = React.useCallback(() => {
        const sessionId = props.sessionId;
        if (!canInitialize || typeof sessionId !== 'string' || sessionId.length === 0 || busy) return;

        void (async () => {
            const confirmed = await Modal.confirm(
                t('files.repositoryInit.confirmTitle'),
                t('files.repositoryInit.confirmBody'),
                {
                    confirmText: t('files.repositoryInit.initialize'),
                    cancelText: t('common.cancel'),
                },
            );
            if (!confirmed) return;

            setBusy(true);
            try {
                const response = await sessionScmRepositoryInit(sessionId, {});
                if (!response.success) {
                    Modal.alert(
                        t('common.error'),
                        response.error || t('files.repositoryInit.errors.failed'),
                    );
                    return;
                }
                await scmStatusSync.invalidateFromMutationAndAwait(sessionId);
                await props.onInitialized?.();
            } finally {
                setBusy(false);
            }
        })();
    }, [busy, canInitialize, props]);

    return (
        <View
            style={{
                flex: 1,
                justifyContent: 'center',
                alignItems: 'center',
                paddingTop: 40,
                paddingHorizontal: 20,
            }}
        >
            <Octicons name="git-branch" size={48} color={theme.colors.textSecondary} />
            <Text
                style={{
                    fontSize: 16,
                    color: theme.colors.textSecondary,
                    textAlign: 'center',
                    marginTop: 16,
                    ...Typography.default(),
                }}
            >
                {t('files.notRepo')}
            </Text>
            <Text
                style={{
                    fontSize: 14,
                    color: theme.colors.textSecondary,
                    textAlign: 'center',
                    marginTop: 8,
                    ...Typography.default(),
                }}
            >
                {t('files.notUnderSourceControl')}
            </Text>
            {canInitialize ? (
                <View style={{ marginTop: 18 }}>
                    <SourceControlUpdateButton
                        theme={theme}
                        testID="scm-not-repo-init"
                        label={busy
                            ? t('files.repositoryInit.initializing')
                            : t('files.repositoryInit.initialize')}
                        kind="primary"
                        disabled={busy}
                        onPress={initializeRepository}
                    />
                </View>
            ) : null}
        </View>
    );
}
