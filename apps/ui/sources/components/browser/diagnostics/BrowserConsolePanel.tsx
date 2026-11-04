import * as React from 'react';

import { selectBrowserDiagnosticEvents, type BrowserDiagnosticEventProjection, type BrowserViewDiagnosticsProjection } from '@/sync/domains/browser/diagnostics';
import { t } from '@/text';

import {
    BrowserDiagnosticsFamilyPanelFrame,
    DiagnosticsFieldList,
    DiagnosticsRow,
    type BrowserDiagnosticsFamilyPanelProps,
    type DiagnosticsField,
    type DiagnosticsTone,
    fieldLabel,
    formatClockTime,
    getBrowserDiagnosticField,
    getBrowserDiagnosticString,
    sanitizeTestIdPart,
} from './BrowserDiagnosticsFamilyPanel';

type ConsoleLevel = 'error' | 'warning' | 'log';

/** Console levels per filter segment, as the store's filter owner reads `data.level`. */
const LEVELS_BY_SEGMENT: Readonly<Record<string, readonly string[] | undefined>> = {
    errors: ['error', 'assert'],
    warnings: ['warning', 'warn'],
    logs: ['log', 'info', 'debug', 'verbose', 'trace', 'dir', 'table'],
};

function consoleLevel(event: BrowserDiagnosticEventProjection): ConsoleLevel {
    if (event.family === 'pageError') return 'error';
    // One level table for the glyph and the filter segments (the store's selector reads the same values).
    const level = String(event.data?.level ?? getBrowserDiagnosticField(event, 'level') ?? '');
    if (LEVELS_BY_SEGMENT.errors?.includes(level)) return 'error';
    if (LEVELS_BY_SEGMENT.warnings?.includes(level)) return 'warning';
    return 'log';
}

function levelTone(level: ConsoleLevel): DiagnosticsTone {
    return level === 'error' ? 'danger' : level === 'warning' ? 'warning' : 'neutral';
}

/** What was logged or thrown, when the page shared it; otherwise `null` (said once, in the tab note). */
function messageText(event: BrowserDiagnosticEventProjection): string | null {
    return getBrowserDiagnosticString(event, 'text') ?? getBrowserDiagnosticString(event, 'message');
}

function consoleCall(event: BrowserDiagnosticEventProjection): string {
    const level = getBrowserDiagnosticField(event, 'level');
    const method = level === 'warning' ? 'warn' : typeof level === 'string' && level.length > 0 ? level : 'log';
    return `console.${method}(…)`;
}

function detailFields(event: BrowserDiagnosticEventProjection, text: string | null): DiagnosticsField[] {
    const fields: DiagnosticsField[] = [];
    if (text) fields.push({ key: 'text', label: fieldLabel('text') ?? '', value: text, mono: true, copy: true });
    const stack = getBrowserDiagnosticString(event, 'stack');
    if (stack) fields.push({ key: 'stack', label: t('browserDiagnostics.host.devtools.fields.stack'), value: stack, mono: true, copy: true });
    const level = getBrowserDiagnosticString(event, 'level');
    if (level) fields.push({ key: 'level', label: fieldLabel('level') ?? '', value: level, mono: true });
    const argCount = getBrowserDiagnosticField(event, 'argCount');
    if (typeof argCount === 'number') fields.push({ key: 'argCount', label: fieldLabel('argCount') ?? '', value: String(argCount) });
    const url = getBrowserDiagnosticString(event, 'url');
    if (url) fields.push({ key: 'url', label: fieldLabel('url') ?? '', value: url, mono: true, copy: true });
    return fields;
}

function renderConsoleRows(
    events: readonly BrowserDiagnosticEventProjection[],
    testID: string,
    familyKey: 'console' | 'pageError',
): React.ReactNode {
    return events.map((event) => {
        const eventId = sanitizeTestIdPart(event.eventId);
        const rowTestID = `${testID}-${familyKey}-row-${eventId}`;
        const level = consoleLevel(event);
        const text = messageText(event);
        const fields = detailFields(event, text);
        const subject = text ?? event.summary ?? (familyKey === 'pageError'
            ? t('browserDiagnostics.host.devtools.console.uncaughtError')
            : consoleCall(event));
        return (
            <DiagnosticsRow
                key={event.eventId}
                testID={rowTestID}
                tone={levelTone(level)}
                subject={subject}
                subjectMuted={!text}
                meta={[{ text: formatClockTime(event.capturedAtMs) }]}
                renderDetail={fields.length > 0
                    ? () => <DiagnosticsFieldList fields={fields} testID={`${rowTestID}-detail`} />
                    : undefined}
            />
        );
    });
}

/** Only the events matter to the selector; a panel rendered without its view passes an empty one. */
const EMPTY_PROJECTION: BrowserViewDiagnosticsProjection = {
    status: 'available', sourceKind: 'browserDiagnostics', browserSessionId: '', viewId: '',
    fidelity: 'unavailable', trusted: false, eventCount: 0, families: [], events: [],
};


export function BrowserConsolePanel(props: BrowserDiagnosticsFamilyPanelProps): React.ReactElement {
    const anyText = React.useMemo(() => props.events.some((event) => messageText(event) !== null), [props.events]);
    const events = props.events;
    const selectItems = React.useCallback((segment: string, query: string) => selectBrowserDiagnosticEvents(
        { ...(props.projection ?? EMPTY_PROJECTION), events },
        { family: 'console', levels: LEVELS_BY_SEGMENT[segment], search: query },
    ), [events, props.projection]);
    return (
        <BrowserDiagnosticsFamilyPanelFrame
            {...props}
            familyKey="console"
            items={props.events}
            countLabel={(count) => t('browserDiagnostics.host.devtools.count.messages', { count })}
            note={anyText ? null : t('browserDiagnostics.host.devtools.console.textNotShared')}
            segments={[
                { id: 'all', label: t('browserDiagnostics.host.devtools.filter.all') },
                { id: 'errors', label: t('browserDiagnostics.host.devtools.filter.errors') },
                { id: 'warnings', label: t('browserDiagnostics.host.devtools.filter.warnings') },
                { id: 'logs', label: t('browserDiagnostics.host.devtools.filter.logs') },
            ]}
            searchPlaceholder={t('browserDiagnostics.host.devtools.search.console')}
            selectItems={selectItems}
            renderItems={(visible) => renderConsoleRows(visible, props.testID, 'console')}
        />
    );
}

export function BrowserPageErrorPanel(props: BrowserDiagnosticsFamilyPanelProps): React.ReactElement {
    const anyText = React.useMemo(() => props.events.some((event) => messageText(event) !== null), [props.events]);
    return (
        <BrowserDiagnosticsFamilyPanelFrame
            {...props}
            familyKey="pageError"
            items={props.events}
            countLabel={(count) => t('browserDiagnostics.host.devtools.count.errors', { count })}
            note={anyText ? null : t('browserDiagnostics.host.devtools.console.errorTextNotShared')}
            renderItems={(events) => renderConsoleRows(events, props.testID, 'pageError')}
        />
    );
}
