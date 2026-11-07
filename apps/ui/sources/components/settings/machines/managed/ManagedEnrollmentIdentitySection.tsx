import * as React from 'react';
import { ManagedMachineEnrollmentIdentityV1Schema, type ManagedMachineEnrollmentIdentityV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';

import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { InlineCode } from '@/components/ui/text/InlineCode';
import { t } from '@/text';

type DedicatedIdentity = Extract<ManagedMachineEnrollmentIdentityV1, { kind: 'dedicatedDaemonUser' }>;
type AdminAccessAtCreation = DedicatedIdentity['adminAccessAtCreation'];

/** The draft's identity only when it is complete: an Ask still waiting for its administrator is not reviewed. */
export function isManagedEnrollmentIdentityReviewed(identity: ManagedMachineEnrollmentIdentityV1 | undefined): boolean {
    return identity !== undefined && ManagedMachineEnrollmentIdentityV1Schema.safeParse(identity).success;
}

type SectionProps = Readonly<{
    identity: ManagedMachineEnrollmentIdentityV1;
    /** The draft owner's declared default state (`managedConfiguratorEnrollmentDefault`), only while the identity is defaulted. */
    declared?: Readonly<{ unavailableReason?: 'dedicated_identity_requires_linux'; awaitingGuestPlatform?: true; guestImageOffered?: true }>;
    /** The computer whose setup step creates the server, named in Ask's password disclosure. */
    computer: string;
    disabled: boolean;
    onChange: (next: DedicatedIdentity) => void;
    testID: string;
}>;

/**
 * How Happier will run on the machine it creates. One section in every state, so a selection never inserts it
 * mid-page: a server's own `happier` user with its administrator access (lab `machine/add/create`, `createAsk`,
 * `admin`); a declared server waiting on a guest image to choose, or on a guest that can't host that user, keeps
 * the section and says what it needs (it stays out until an image choice exists); a personal machine or a sandbox
 * gets one read-only line.
 */
export function ManagedEnrollmentIdentitySection(props: SectionProps) {
    const { identity } = props;
    if (identity.kind === 'dedicatedDaemonUser') return <DedicatedIdentitySection {...props} identity={identity} />;
    // Before an image can be chosen the section has nothing to ask; the page's own account or loading line says what comes first.
    if (props.declared?.awaitingGuestPlatform && !props.declared.guestImageOffered) return null;
    const server = props.declared?.awaitingGuestPlatform || props.declared?.unavailableReason !== undefined;
    return (
        <ItemGroup testID={`${props.testID}.identity`} title={t('managedMachines.identity.title')} description={server ? <>
            {t('managedMachines.identity.serverDescriptionBefore')}<InlineCode>happier</InlineCode>{t('managedMachines.identity.serverDescriptionAfter')}
        </> : undefined}>
            {props.declared?.awaitingGuestPlatform
                ? <Item testID={`${props.testID}.identity.pending`} mode="info" showChevron={false}
                    title={t('managedMachines.identity.adminAccess')} subtitle={t('managedMachines.identity.guestPlatformPending')} />
                : <Item testID={`${props.testID}.identity.runs-as`} mode="info" showChevron={false} subtitleLines={0}
                    title={t(identity.kind === 'guestProcess' ? 'managedMachines.identity.runsInSandbox' : 'managedMachines.identity.runsAsAccount')}
                    subtitle={t(server ? 'managedMachines.identity.notLinux' : identity.kind === 'guestProcess'
                        ? 'managedMachines.identity.runsInSandboxDescription' : 'managedMachines.identity.runsAsAccountDescription')} />}
        </ItemGroup>
    );
}

/**
 * The server's own `happier` user and the administrator access chosen at creation. The draft arrives with the
 * disclosed Preauthorized default; this section only edits it. An Ask choice stays Ask while its administrator is
 * being named, so an incomplete choice never turns back into the default behind the person's back.
 */
function DedicatedIdentitySection(props: SectionProps & Readonly<{ identity: DedicatedIdentity }>) {
    const { identity, onChange } = props;
    // The name typed for Ask survives a look at the other choices; only Ask carries it into the draft.
    const [username, setUsername] = React.useState(identity.administrator?.username ?? '');
    const withMode = (mode: AdminAccessAtCreation, name: string): DedicatedIdentity => {
        const { administrator: _previous, ...rest } = identity;
        return { ...rest, adminAccessAtCreation: mode, ...(mode === 'ask' && name ? { administrator: { username: name } } : {}) };
    };
    const options = React.useMemo(() => [
        { id: 'none' as const, label: t('managedMachines.identity.none'), description: t('managedMachines.identity.noneDescription') },
        { id: 'ask' as const, label: t('managedMachines.identity.ask'), description: t('managedMachines.identity.askDescription') },
        { id: 'preauthorized' as const, label: t('managedMachines.identity.preauthorized'), description: t('managedMachines.identity.preauthorizedDescription') },
    ], []);
    const ask = identity.adminAccessAtCreation === 'ask';
    const invalid = ask && username !== '' && !isManagedEnrollmentIdentityReviewed(identity);
    return (
        <ItemGroup testID={`${props.testID}.identity`} title={t('managedMachines.identity.title')} description={<>
            {t('managedMachines.identity.descriptionBefore')}<InlineCode>{identity.username}</InlineCode>{t('managedMachines.identity.descriptionAfter')}
        </>}>
            <SegmentedChoiceItem<AdminAccessAtCreation> title={t('managedMachines.identity.adminAccess')} options={options}
                value={identity.adminAccessAtCreation} disabled={props.disabled} testIDPrefix={`${props.testID}.admin-access`}
                onChange={mode => onChange(withMode(mode, username))} />
            {ask ? <Item title={t('managedMachines.identity.administrator')} showChevron={false} accessoryLayout="adaptive"
                subtitle={t('managedMachines.identity.administratorDisclosure', { computer: props.computer })} subtitleLines={0}
                rightElement={<FieldTextInput testID={`${props.testID}.administrator`} value={username}
                    accessibilityLabel={t('managedMachines.identity.administrator')} placeholder={t('managedMachines.identity.administratorPlaceholder')}
                    autoCapitalize="none" autoComplete="off" editable={!props.disabled}
                    error={invalid ? t('managedMachines.identity.administratorInvalid') : undefined}
                    onChangeText={name => { setUsername(name); onChange(withMode('ask', name)); }} />} /> : null}
        </ItemGroup>
    );
}
