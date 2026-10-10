import * as React from 'react';
import { StyleSheet } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

export type PluginUiDiagnostic = Readonly<{
    code: string;
    message: string;
    details?: unknown;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function formatPluginUiDiagnosticMessage(diagnostic: PluginUiDiagnostic): string {
    const details = diagnostic.details;
    if (!isRecord(details) || !isRecord(details.target) || !isRecord(details.contributor) || !isRecord(details.protocol)) {
        return diagnostic.message;
    }
    const { target, contributor, protocol } = details;
    if (
        typeof target.pluginId !== 'string'
        || typeof target.pointId !== 'string'
        || typeof contributor.pluginId !== 'string'
        || typeof contributor.contributionId !== 'string'
        || typeof protocol.id !== 'string'
        || typeof protocol.version !== 'number'
        || typeof details.reason !== 'string'
    ) return diagnostic.message;
    return `${diagnostic.message}\n${contributor.pluginId}/${contributor.contributionId} → ${target.pluginId}/${target.pointId} · ${protocol.id}@${protocol.version} · ${details.reason}`;
}

export function PluginDiagnosticsSection(props: Readonly<{
    title: string;
    diagnostics: readonly PluginUiDiagnostic[];
    testIDPrefix: string;
}>) {
    if (props.diagnostics.length === 0) return null;

    return (
        <ItemGroup title={props.title}>
            {props.diagnostics.map((diagnostic, index) => (
                <Item
                    key={`${diagnostic.code}:${diagnostic.message}:${index}`}
                    testID={`${props.testIDPrefix}.${diagnostic.code}.${index}`}
                    title={t('settingsPlugins.diagnosticsIssueTitle')}
                    subtitle={(
                        <Text
                            testID={`${props.testIDPrefix}.${diagnostic.code}.${index}.message`}
                            selectable
                            style={styles.message}
                        >
                            {formatPluginUiDiagnosticMessage(diagnostic)}
                            {'\n'}
                            {t('settingsPlugins.diagnosticsRecovery')}
                            {'\n'}
                            <Text
                                testID={`${props.testIDPrefix}.${diagnostic.code}.${index}.code`}
                                selectable
                            >
                                {t('settingsPlugins.diagnosticsTechnicalCode', { code: diagnostic.code })}
                            </Text>
                        </Text>
                    )}
                    subtitleLines={0}
                    showChevron={false}
                    mode="info"
                />
            ))}
        </ItemGroup>
    );
}

const styles = StyleSheet.create((theme) => ({
    message: {
        color: theme.colors.text.secondary,
    },
}));
