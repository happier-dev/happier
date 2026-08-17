import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Modal } from '@/modal';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { SourceControlUpdateButton } from '@/components/workspaces/scm/update/SourceControlUpdateControls';
import { Icon } from '@/components/ui/icons/Icon';

type RepositoryInitResponse = Readonly<{
    success: boolean;
    error?: string;
}>;

export function NotSourceControlRepositoryState(props: Readonly<{
    canInitializeRepository?: boolean;
    initializeRepositoryBusy?: boolean;
    onInitializeRepository?: () => Promise<RepositoryInitResponse>;
    onRefresh?: () => Promise<void>;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const [busy, setBusy] = React.useState(false);

    const initializeRepository = React.useCallback(() => {
        const onInitializeRepository = props.onInitializeRepository;
        if (!onInitializeRepository || busy || props.initializeRepositoryBusy) return;
        void (async () => {
            const confirmed = await Modal.confirm(
                t('files.sourceControlOperations.repositoryInit.confirmTitle'),
                t('files.sourceControlOperations.repositoryInit.confirmBody'),
                {
                    confirmText: t('files.sourceControlOperations.repositoryInit.confirm'),
                    cancelText: t('common.cancel'),
                },
            );
            if (!confirmed) return;
            setBusy(true);
            try {
                const response = await onInitializeRepository();
                if (!response.success) {
                    Modal.alert(t('common.error'), response.error || t('files.sourceControlOperations.repositoryInit.failed'));
                    return;
                }
                await props.onRefresh?.();
            } finally {
                setBusy(false);
            }
        })();
    }, [busy, props]);

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
            <Icon name="git-branch" size={48} color={theme.colors.text.secondary} />
            <Text
                style={{
                    fontSize: 16,
                    color: theme.colors.text.secondary,
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
                    color: theme.colors.text.secondary,
                    textAlign: 'center',
                    marginTop: 8,
                    ...Typography.default(),
                }}
            >
                {t('files.notUnderSourceControl')}
            </Text>
            {props.canInitializeRepository === true ? (
                <View style={{ marginTop: 16 }}>
                    <SourceControlUpdateButton
                        theme={theme}
                        testID="scm-repository-init"
                        label={t('files.sourceControlOperations.repositoryInit.action')}
                        kind="primary"
                        disabled={busy || props.initializeRepositoryBusy === true}
                        onPress={initializeRepository}
                    />
                </View>
            ) : null}
        </View>
    );
}
