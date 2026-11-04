import * as React from 'react';

import type { BrowserDiagnosticEventProjection } from '@/sync/domains/browser/diagnostics';
import { t } from '@/text';

import {
    BrowserDiagnosticsFamilyPanelFrame,
    DiagnosticsFieldList,
    type BrowserDiagnosticsFamilyPanelProps,
    type DiagnosticsField,
    fieldLabel,
    formatBrowserDiagnosticFieldValue,
} from './BrowserDiagnosticsFamilyPanel';

const INFO_ORDER = ['title', 'url', 'readyState', 'nodeCount', 'elementCount', 'maxDepth', 'serviceWorker', 'webgl', 'webrtc'] as const;
const MONO_KEYS = new Set(['url']);
const COPY_KEYS = new Set(['url', 'title']);

/** One key/value sheet for the page: its latest value for each fact, each fact once. */
function pageInfoFields(events: readonly BrowserDiagnosticEventProjection[]): DiagnosticsField[] {
    const latest = new Map<string, string | number | boolean>();
    for (const event of events) {
        for (const field of event.detail?.fields ?? []) latest.set(field.key, field.value);
    }
    if (!latest.has('title') && latest.get('titleAvailable') === false) {
        latest.set('title', t('browserDiagnostics.host.devtools.info.titleNotShared'));
    }
    const fields: DiagnosticsField[] = [];
    const keys = [...INFO_ORDER, ...[...latest.keys()].filter((key) => !(INFO_ORDER as readonly string[]).includes(key))];
    for (const key of keys) {
        const value = latest.get(key);
        const label = fieldLabel(key);
        if (typeof value === 'undefined' || !label) continue;
        fields.push({
            key,
            label,
            value: formatBrowserDiagnosticFieldValue(value),
            mono: MONO_KEYS.has(key),
            copy: COPY_KEYS.has(key) && typeof value === 'string',
        });
    }
    return fields;
}

export function BrowserPageInfoPanel(props: BrowserDiagnosticsFamilyPanelProps): React.ReactElement {
    const fields = React.useMemo(() => pageInfoFields(props.events), [props.events]);
    return (
        <BrowserDiagnosticsFamilyPanelFrame
            {...props}
            familyKey="pageInfo"
            items={fields.length > 0 ? [fields] : []}
            renderItems={() => (
                <DiagnosticsFieldList variant="sheet" fields={fields} testID={`${props.testID}-pageInfo-fields`} />
            )}
        />
    );
}
