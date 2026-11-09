import * as React from 'react';
import type { MachineSetupV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';

import { useSoftwareOptions } from '@/components/store/catalog/storeSoftware';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Modal } from '@/modal';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import type { CustomModalInjectedProps } from '@/modal/types';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';

import { machineSetupItemPresentation } from './machineSetupItems';
import { describeMachineSetup, machineSetupItemReadRow } from './MachineSetupSection';
import { MachineSetupReviewFooter } from './MachineSetupPlanReview';

export type ManagedCreationReviewProps = Readonly<{
    name: string;
    server: Readonly<{ title: string; spec: string; mark: React.ReactNode }>;
    preset: Readonly<{ name: string; revision: number }>;
    setup: MachineSetupV1;
    scope: ServerAccountScope | null;
    administrator?: string;
    confirmLabel: string;
    /** The one acquire. The review closes first: progress, approval and failure read on the configurator. */
    onConfirm: () => void;
}>;

/** One confirm for the whole plan (lab `q/review`, phone `qp/review`): the server, what the Preset sets up, and the answers. */
export function showManagedCreationReview(props: ManagedCreationReviewProps) {
    return Modal.show({ component: ManagedCreationReview, props });
}

function ManagedCreationReview(props: ManagedCreationReviewProps & CustomModalInjectedProps) {
    const { onClose, onConfirm } = props;
    const items = props.setup.items ?? [];
    const recipes = items.filter(item => item.kind !== 'app');
    const apps = items.filter(item => item.kind === 'app');
    const target = React.useMemo(() => props.scope ? { scope: props.scope, machine: null } : null, [props.scope]);
    const software = useSoftwareOptions(target, { presented: recipes.length > 0 });
    const offers = software.state.status === 'ready' ? software.state.options : null;
    const footer = React.useMemo(() => (
        <MachineSetupReviewFooter onCancel={onClose} cancelTestID="managed-config.review.cancel"
            primary={{ label: props.confirmLabel, testID: 'managed-config.review.confirm', onPress: () => { onClose(); onConfirm(); } }} />
    ), [onClose, onConfirm, props.confirmLabel]);
    const chrome = React.useMemo(() => ({
        kind: 'card' as const,
        title: t('managedMachines.creationReview.title', { name: props.name }),
        subtitle: t('managedMachines.creationReview.description', { name: props.name }),
        footer,
        phonePresentation: 'fullscreen' as const,
        dimensions: { size: 'md' as const, maxHeightRatio: 0.84 },
    }), [footer, props.name]);
    useModalCardChrome(props.setChrome, chrome);
    const row = (item: (typeof items)[number]) => {
        const read = machineSetupItemReadRow(item, machineSetupItemPresentation(item, offers));
        return <Item key={`${item.kind}:${read.title}`} {...read} subtitleLines={0} mode="info" showChevron={false} />;
    };
    const setupFacts = describeMachineSetup(props.setup).filter(fact => fact.id !== 'setup-items');
    return (
        <ItemList presentation="grouped" keyboardShouldPersistTaps="handled" testID="managed-config.review">
            <ItemGroup title={t('managedMachines.creationReview.server')}>
                <Item testID="managed-config.review.server" icon={props.server.mark} title={props.server.title} subtitle={props.server.spec}
                    subtitleLines={0} mode="info" showChevron={false} />
            </ItemGroup>
            {recipes.length || setupFacts.length ? <ItemGroup title={t('managedMachines.creationReview.setupAndSoftware')}
                description={t('managedMachines.creationReview.fromPresetInOrder', { preset: props.preset.name, revision: props.preset.revision })}>
                {recipes.map(row)}
                {setupFacts.map(fact => <Item key={fact.id} title={fact.label} subtitle={fact.value} subtitleLines={0} mode="info" showChevron={false} />)}
            </ItemGroup> : null}
            {apps.length ? <ItemGroup title={t('machinePresets.setup.review.apps')}
                description={t('managedMachines.creationReview.fromPreset', { preset: props.preset.name })}>
                {apps.map(row)}
            </ItemGroup> : null}
            <ItemGroup>
                {props.administrator ? <Item testID="managed-config.review.administrator" title={t('machinePresets.setup.review.administrator')}
                    subtitle={props.administrator} mode="info" showChevron={false} /> : null}
                <Item testID="managed-config.review.downtime" title={t('machinePresets.setup.review.downtime')}
                    subtitle={t('managedMachines.creationReview.downtimeNone', { name: props.name })} mode="info" showChevron={false} />
            </ItemGroup>
        </ItemList>
    );
}
