import * as React from 'react';
import { doesHappierCapabilityStatusSpeak } from '@happier-dev/plugin-ui/presentation';

import { buildCapabilityHeaderMeta, type CapabilityFactsProps } from '@/components/capabilities/facts/CapabilityFacts';
import { CapabilityStatusChip } from '@/components/capabilities/status/CapabilityStatusChip';
import type { CapabilityStatus } from '@/components/capabilities/status/capabilityStatusPresentation';
import { PageHeader, type PageHeaderPrimaryAction } from '@/components/ui/layout/PageHeader';
import { PageHeaderMenu, type PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';
import { PageHeaderMarkSlot } from '@/components/ui/layout/PageHeaderMarkSlot';

/** A purpose comes from the capability's own text (a skill's frontmatter), so it stops at two lines. */
const PURPOSE_MAX_LINES = 2;

/**
 * A capability's detail header (P5 detail grammar): its mark, name and purpose, then the facts that
 * distinguish it on the header's one meta line (source, transport, cost; a registry id in mono), a
 * header-placement status only when it says something the page does not, and rare operations behind ⋯.
 */
export function CapabilityDetailHeader(props: Readonly<{
    mark?: React.ReactNode;
    title: string;
    purpose?: string;
    facts: Omit<CapabilityFactsProps, 'presentation'>;
    /** Lines that belong to the identity (what is left out of an import), on the header's own text edge. */
    details?: React.ReactNode;
    status?: CapabilityStatus | null;
    /** Rare operations behind ⋯ (Duplicate, Copy install link). */
    menuItems?: readonly PageHeaderMenuAction[];
    /** An identifier under the facts, in mono (a registry id). */
    mono?: string;
    /** The registry verified the publisher of that identifier: a shield leads it. */
    monoVerified?: boolean;
    /** Unsaved edits on the page (Save). */
    primaryAction?: PageHeaderPrimaryAction;
    testID: string;
}>): React.ReactElement {
    const meta = React.useMemo(() => {
        const facts = buildCapabilityHeaderMeta(props.facts);
        return props.mono
            ? [...facts, { key: 'mono', text: props.mono, mono: true, ...(props.monoVerified ? { icon: 'shield-check' as const } : {}) }]
            : facts;
    }, [props.facts, props.mono, props.monoVerified]);
    const speaks = props.status ? doesHappierCapabilityStatusSpeak(props.status, 'header') : false;
    return (
        <PageHeader
            testID={props.testID}
            alwaysShowTitle
            title={props.title}
            description={props.purpose}
            descriptionLines={PURPOSE_MAX_LINES}
            meta={meta}
            leading={props.mark ? <PageHeaderMarkSlot>{props.mark}</PageHeaderMarkSlot> : undefined}
            // A listing's icon row is its mark and name; its purpose and facts read from the content edge.
            markSpan="title"
            titleAccessory={speaks && props.status ? <CapabilityStatusChip status={props.status} placement="header" testID={`${props.testID}.status`} /> : undefined}
            actions={props.menuItems && props.menuItems.length > 0
                ? <PageHeaderMenu testID={`${props.testID}.menu`} actions={props.menuItems} />
                : undefined}
            actionsPlacement="page"
            primaryAction={props.primaryAction}
            {...(props.details ? { details: props.details, detailsPlacement: 'column' as const } : {})}
        />
    );
}
