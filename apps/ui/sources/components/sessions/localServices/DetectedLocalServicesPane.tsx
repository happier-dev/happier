import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import { useLocalServiceInventory } from '@/sync/domains/local/services/inventory/useLocalServiceInventory';
import type { LocalServiceInventoryState } from '@/sync/domains/local/services/inventory/store';
import type { ManagedLocalServicesState } from '@/sync/domains/local/services/managed/store';
import { t } from '@/text';

import { DetectedLocalServiceRow } from './DetectedLocalServiceRow';
import { ManagedLocalServiceRow } from './ManagedLocalServiceRow';
import { readLocalServiceDiagnostics } from './presentation';

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        minHeight: 0,
        backgroundColor: theme.colors.surface.base,
        paddingBottom: 16,
    },
    statusPanel: {
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        paddingHorizontal: 24,
        paddingVertical: 32,
    },
    statusText: {
        color: theme.colors.text.secondary,
        textAlign: 'center',
    },
    banner: {
        marginHorizontal: 16,
        marginTop: 12,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
    },
    bannerText: {
        color: theme.colors.text.secondary,
    },
}));

function DiagnosticsBanner(props: Readonly<{
    diagnostics: readonly unknown[];
    testID: string;
}>): React.ReactElement | null {
    const diagnostics = readLocalServiceDiagnostics(props.diagnostics);
    const styles = stylesheet;
    if (diagnostics.length === 0) {
        return null;
    }

    return (
        <View testID={props.testID} style={styles.banner}>
            {diagnostics.map((diagnostic) => (
                <Text key={diagnostic.code} style={styles.bannerText}>
                    {t('localServices.inventory.diagnostic', { value: diagnostic.code })}
                </Text>
            ))}
        </View>
    );
}

export function DetectedLocalServicesPane(props: Readonly<{
    inventoryState: LocalServiceInventoryState;
    managedState?: ManagedLocalServicesState | null;
    testID?: string;
}>): React.ReactElement {
    const testID = props.testID ?? 'detected-local-services-pane';
    const viewModel = useLocalServiceInventory({
        inventoryState: props.inventoryState,
        managedState: props.managedState ?? null,
    });
    const styles = stylesheet;
    const managedByInventoryId = React.useMemo(() => {
        const out = new Map<string, (typeof viewModel.managedRows)[number]>();
        for (const row of viewModel.managedRows) {
            if (row.inventoryId) {
                out.set(row.inventoryId, row);
            }
        }
        return out;
    }, [viewModel.managedRows]);

    if (viewModel.status === 'loading') {
        return (
            <View testID={`${testID}-loading`} style={styles.statusPanel}>
                <ActivitySpinner />
                <Text style={styles.statusText}>{t('localServices.inventory.loadingTitle')}</Text>
            </View>
        );
    }

    if (viewModel.status === 'empty') {
        return (
            <View testID={`${testID}-empty`} style={styles.statusPanel}>
                <Text style={styles.statusText}>{t('localServices.inventory.emptyTitle')}</Text>
            </View>
        );
    }

    if (viewModel.status === 'error') {
        return (
            <View testID={`${testID}-error`} style={styles.statusPanel}>
                <Text style={styles.statusText}>{t('localServices.inventory.errorTitle')}</Text>
                <DiagnosticsBanner diagnostics={viewModel.diagnostics} testID={`${testID}-error-diagnostics`} />
            </View>
        );
    }

    return (
        <View testID={testID} style={styles.root}>
            {viewModel.isRefreshing ? (
                <View testID={`${testID}-refreshing`} style={styles.banner}>
                    <Text style={styles.bannerText}>{t('localServices.inventory.refreshing')}</Text>
                </View>
            ) : null}
            <DiagnosticsBanner diagnostics={viewModel.diagnostics} testID={`${testID}-error`} />
            <ItemGroup
                title={t('localServices.inventory.title')}
                selectableItemCountOverride={viewModel.rows.length}
            >
                {viewModel.rows.map((row) => (
                    <DetectedLocalServiceRow
                        key={row.id}
                        row={row}
                        managed={managedByInventoryId.get(row.id) ?? null}
                        testID={`${testID}-detected:${row.id}`}
                    />
                ))}
            </ItemGroup>
            {viewModel.managedRows.length > 0 ? (
                <ItemGroup
                    title={t('localServices.managed.title')}
                    selectableItemCountOverride={viewModel.managedRows.length}
                >
                    {viewModel.managedRows.map((row) => (
                        <ManagedLocalServiceRow
                            key={row.id}
                            row={row}
                            testID={`${testID}-managed:${row.id}`}
                        />
                    ))}
                </ItemGroup>
            ) : (
                <Item
                    testID={`${testID}-managed-empty`}
                    title={t('localServices.managed.emptyTitle')}
                    mode="info"
                    showChevron={false}
                />
            )}
        </View>
    );
}
