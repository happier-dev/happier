import { BrowserScreenshotMediaReferenceV1Schema } from '@happier-dev/protocol/browser/context/v1';
import { BrowserCommandDispatchResultV1Schema } from '@happier-dev/protocol/browser/control/v1';
import { BrowserViewTargetV1Schema, type BrowserViewTargetV1 } from '@happier-dev/protocol/browser/target/v1';
import { listActionSpecs } from '@happier-dev/protocol/actions/actionSpecs';
import { maybeParseJson } from '@happier-dev/protocol/activity/parseJson';
import { parseLocator } from '@happier-dev/protocol/browser/automation/locators';

import type { ToolCall } from '@happier-dev/session-core/messages';
import { formatBrowserDisplayUrl } from '@/sync/domains/browser/shell';

import {
    createHappierActionToolNameIndex,
    isRecord,
    readHappierActionExecuteActionId,
    readHappierActionId,
    readHappierActionToolResultCandidates,
} from './happierActionToolResult';

/**
 * The one projection from a transcript tool call to "what the agent did in the browser" (lab
 * `browser` T): the action in words, the element it acted on, the page, a screenshot when the call
 * produced one, and the view to watch.
 *
 * It reads the call only through the canonical owners: the Action spec index for direct bindings,
 * the first-party `action_execute` tool for the generic path, the Protocol screenshot reference
 * schema for media and the Protocol target schema for an openable view. It never shows a selector,
 * a URL's query or fragment, or anything the agent typed.
 */

export type TranscriptBrowserActionVerb =
    | 'open'
    | 'reload'
    | 'back'
    | 'forward'
    | 'click'
    | 'type'
    | 'fill'
    | 'press'
    | 'scroll'
    | 'point'
    | 'select'
    | 'upload'
    | 'drag'
    | 'look'
    | 'screenshot'
    | 'recordingStarted'
    | 'recordingStopped'
    | 'other';

export type TranscriptBrowserScreenshot = Readonly<{
    mediaId: string;
    sessionId: string;
    /**
     * Whose store holds the bytes: the Session's working directory, or the daemon's Session media
     * store under its home directory (the managed browser's captures, W2B).
     */
    storage: 'session' | 'daemon';
    path: string;
    sha256: string;
    width: number;
    height: number;
    sizeBytes: number;
}>;

export type TranscriptBrowserActionReference = Readonly<{
    actionId: string;
    verb: TranscriptBrowserActionVerb;
    /** An accessible name or visible text the agent targeted; never a selector or typed value. */
    targetLabel: string | null;
    /** A key the agent pressed (Enter, Tab). */
    keyLabel: string | null;
    /** The page, as `host/path` with no query or fragment. */
    pageLabel: string | null;
    screenshot: TranscriptBrowserScreenshot | null;
    view: Readonly<{ browserSessionId: string; viewId: string }> | null;
    /** The exact view to resolve through its current owner; an input URL is not daemon identity. */
    watch: Readonly<{ browserSessionId: string; viewId: string; target?: BrowserViewTargetV1 }> | null;
}>;

const BROWSER_ACTION_IDS: readonly string[] = listActionSpecs()
    .map((spec) => spec.id as string)
    .filter((id) => id.startsWith('browser.'));
const BROWSER_ACTION_ID_SET = new Set(BROWSER_ACTION_IDS);
const BROWSER_ACTION_ID_BY_TOOL_NAME = createHappierActionToolNameIndex<string>(BROWSER_ACTION_IDS);

function isBrowserActionId(actionId: string): actionId is string {
    return BROWSER_ACTION_ID_SET.has(actionId);
}

/** Identity only: discovery does not need labels, locators, screenshots or result traversal. */
export function readTranscriptBrowserActionIdentity(input: Readonly<{ toolName: string; input: unknown }>):
    Readonly<{ actionId: string; generic: boolean }> | null {
    const directActionId = readHappierActionId(input.toolName, BROWSER_ACTION_ID_BY_TOOL_NAME);
    if (directActionId) return { actionId: directActionId, generic: false };
    const actionId = readHappierActionExecuteActionId(input.toolName, input.input, isBrowserActionId);
    return actionId ? { actionId, generic: true } : null;
}

const AUTOMATION_VERBS: Readonly<Record<string, TranscriptBrowserActionVerb>> = {
    navigate: 'open',
    reload: 'reload',
    goBack: 'back',
    goForward: 'forward',
    click: 'click',
    tap: 'click',
    type: 'type',
    setValue: 'fill',
    press: 'press',
    scroll: 'scroll',
    hover: 'point',
    focus: 'point',
    select: 'select',
    upload: 'upload',
    drag: 'drag',
    snapshot: 'look',
    semanticSnapshot: 'look',
    queryElements: 'look',
    waitFor: 'look',
    status: 'look',
};

function resolveVerb(actionId: string): TranscriptBrowserActionVerb {
    if (actionId.startsWith('browser.automation.')) {
        return AUTOMATION_VERBS[actionId.slice('browser.automation.'.length)] ?? 'look';
    }
    switch (actionId) {
        case 'browser.view.open':
        case 'browser.target.set':
        case 'browser.navigate':
            return 'open';
        case 'browser.reload':
            return 'reload';
        case 'browser.goBack':
            return 'back';
        case 'browser.goForward':
            return 'forward';
        case 'browser.context.captureScreenshot':
        case 'browser.context.annotation.captureRegion':
        case 'browser.context.annotation.captureElement':
            return 'screenshot';
        case 'browser.recording.start':
            return 'recordingStarted';
        case 'browser.recording.stop':
            return 'recordingStopped';
        default:
            return actionId.startsWith('browser.context.') || actionId.startsWith('browser.diagnostics.')
                ? 'look'
                : 'other';
    }
}

/**
 * The accessible name or visible text inside a semantic locator (`role=button[name="Sign in"]`,
 * `text=Create account`), the grammar the daemon's automation locators accept. Anything else — a CSS
 * selector, a test id — names nothing a person reads, so it stays unnamed.
 */
function readLocatorLabel(locator: unknown): string | null {
    if (typeof locator !== 'string') return null;
    const parsed = parseLocator(locator);
    const label = parsed.strategy === 'role' ? parsed.name : parsed.strategy === 'text' ? parsed.text : null;
    return label?.trim() || null;
}

function readPageLabel(value: unknown): string | null {
    if (typeof value !== 'string' || !value.trim()) return null;
    let url: URL;
    try {
        url = new URL(value.trim());
    } catch {
        return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const display = formatBrowserDisplayUrl(`${url.origin}${url.pathname}`);
    return display || null;
}

function readString(record: Readonly<Record<string, unknown>> | null, key: string): string | null {
    const value = record?.[key];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readView(input: Readonly<Record<string, unknown>> | null): TranscriptBrowserActionReference['view'] {
    const browserSessionId = readString(input, 'browserSessionId');
    const viewId = readString(input, 'viewId');
    return browserSessionId && viewId ? { browserSessionId, viewId } : null;
}

function readDispatchedView(value: unknown): TranscriptBrowserActionReference['view'] {
    const result = isRecord(value) && value.ok === true ? value.result : value;
    const parsed = BrowserCommandDispatchResultV1Schema.safeParse(result);
    if (!parsed.success || parsed.data.status !== 'dispatched') return null;
    for (const event of parsed.data.events) {
        if (event.kind === 'viewOpened') return { browserSessionId: event.browserSessionId, viewId: event.viewId };
    }
    return null;
}

function findSessionScreenshot(value: unknown): TranscriptBrowserScreenshot | null {
    if (Array.isArray(value)) {
        for (const entry of value) {
            const found = findSessionScreenshot(entry);
            if (found) return found;
        }
        return null;
    }
    if (!isRecord(value)) return null;
    if (value.mediaKind === 'image' && typeof value.mediaId === 'string') {
        const parsed = BrowserScreenshotMediaReferenceV1Schema.safeParse(value);
        // Only stored bytes earn a thumbnail: a reference without its file has nothing to show.
        if (parsed.success && parsed.data.file) {
            const file = parsed.data.file;
            return {
                mediaId: parsed.data.mediaId,
                sessionId: file.sessionId,
                storage: file.storage,
                path: file.path,
                sha256: file.sha256,
                width: parsed.data.width,
                height: parsed.data.height,
                sizeBytes: parsed.data.sizeBytes,
            };
        }
        return null;
    }
    for (const nested of Object.values(value)) {
        const found = findSessionScreenshot(nested);
        if (found) return found;
    }
    return null;
}

export function resolveTranscriptBrowserActionReference(input: Readonly<{
    toolName: string;
    state: ToolCall['state'] | string;
    input: unknown;
    result: unknown;
}>): TranscriptBrowserActionReference | null {
    const identity = readTranscriptBrowserActionIdentity(input);
    if (!identity) return null;
    const { actionId } = identity;

    const toolInput = maybeParseJson(input.input);
    const actionInputValue = identity.generic && isRecord(toolInput) ? maybeParseJson(toolInput.input) : toolInput;
    const actionInput = isRecord(actionInputValue) ? actionInputValue : null;
    const payload = isRecord(actionInput?.payload) ? actionInput.payload : null;
    const verb = resolveVerb(actionId);

    const targetLabel = readLocatorLabel(payload?.locator) ?? readLocatorLabel(payload?.selector);
    const keyLabel = verb === 'press' ? readString(payload, 'key') : null;
    const targetValue = actionInput?.target;
    const target = targetValue === undefined ? null : BrowserViewTargetV1Schema.safeParse(targetValue);
    const targetUrl = target?.success && 'url' in target.data ? target.data.url : null;
    const pageLabel = readPageLabel(payload?.url) ?? readPageLabel(actionInput?.url) ?? readPageLabel(targetUrl);
    let view = readView(actionInput);

    let screenshot: TranscriptBrowserScreenshot | null = null;
    if (input.state === 'completed') {
        for (const candidate of readHappierActionToolResultCandidates(input.result)) {
            view = readDispatchedView(candidate) ?? view;
            screenshot ??= findSessionScreenshot(candidate);
        }
    }

    return Object.freeze({
        actionId,
        verb,
        targetLabel,
        keyLabel,
        pageLabel,
        screenshot,
        view,
        watch: view ? { ...view, ...(target?.success ? { target: target.data } : {}) } : null,
    });
}
