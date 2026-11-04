import * as React from 'react';

import type { BrowserDiagnosticEventProjection } from '@/sync/domains/browser/diagnostics';
import { t } from '@/text';

import {
    BrowserDiagnosticsFamilyPanelFrame,
    DiagnosticsFieldList,
    type BrowserDiagnosticsFamilyPanelProps,
    type DiagnosticsField,
    fieldLabel,
    formatNumber,
    getBrowserDiagnosticField,
    getBrowserDiagnosticNumber,
    getBrowserDiagnosticString,
} from './BrowserDiagnosticsFamilyPanel';

function availabilityWord(value: unknown): string | null {
    if (typeof value === 'string' && value.length > 0) return value;
    if (value === true) return t('browserDiagnostics.host.devtools.elements.shared');
    if (value === false) return t('browserDiagnostics.host.devtools.elements.notShared');
    return null;
}

/**
 * The picked element, then the page's tree size. There is no DOM tree browser: Diagnostics inspects
 * the element the person picks (the tab's one action, in the interaction line), and says so once.
 */
function elementFields(events: readonly BrowserDiagnosticEventProjection[]): DiagnosticsField[] {
    const pick = [...events].reverse().find((event) => event.kind === 'elements.pickerState' && getBrowserDiagnosticString(event, 'selectorPath'));
    const snapshot = [...events].reverse().find((event) => event.kind === 'elements.snapshot');
    const fields: DiagnosticsField[] = [];
    if (pick) {
        const selector = getBrowserDiagnosticString(pick, 'selectorPath');
        if (selector) fields.push({ key: 'selectorPath', label: fieldLabel('selectorPath') ?? '', value: selector, mono: true, copy: true });
        const name = getBrowserDiagnosticString(pick, 'accessibleName')
            ?? availabilityWord(getBrowserDiagnosticField(pick, 'accessibleNameAvailable'));
        if (name) fields.push({ key: 'accessibleName', label: fieldLabel('accessibleName') ?? '', value: name });
    }
    if (snapshot) {
        const nodes = getBrowserDiagnosticNumber(snapshot, 'nodeCount');
        const elements = getBrowserDiagnosticNumber(snapshot, 'elementCount');
        const depth = getBrowserDiagnosticNumber(snapshot, 'maxDepth');
        if (nodes !== null) fields.push({ key: 'nodeCount', label: fieldLabel('nodeCount') ?? '', value: formatNumber(nodes) });
        if (elements !== null) fields.push({ key: 'elementCount', label: fieldLabel('elementCount') ?? '', value: formatNumber(elements) });
        if (depth !== null) fields.push({ key: 'maxDepth', label: fieldLabel('maxDepth') ?? '', value: formatNumber(depth) });
    }
    return fields;
}

export function BrowserElementsPanel(props: BrowserDiagnosticsFamilyPanelProps): React.ReactElement {
    const fields = React.useMemo(() => elementFields(props.events), [props.events]);
    const picked = fields.some((field) => field.key === 'selectorPath');
    return (
        <BrowserDiagnosticsFamilyPanelFrame
            {...props}
            familyKey="elements"
            items={fields.length > 0 ? [fields] : []}
            note={picked ? t('browserDiagnostics.host.devtools.elements.noTree') : t('browserDiagnostics.host.devtools.elements.pickHint')}
            renderItems={() => (
                <DiagnosticsFieldList variant="sheet" fields={fields} testID={`${props.testID}-elements-selection`} />
            )}
        />
    );
}
