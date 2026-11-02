import { BrowserProfileLoginsImportV1Schema, BrowserProfileLoginsImportResultV1Schema } from '../../browser/profile/loginsV1.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

import type { RuntimeActionIdV1 } from '../actionIds.js';
import type { ActionInputFieldHint } from '../actionInputHints.js';
import { SecretFillSettlementV1Schema } from '../../computer/v1.js';
import {
  BrowserAutomationActionRequestV1Schema,
  BrowserAutomationSecretFillRequestV1Schema,
  BrowserAutomationActionResultV1Schema as BrowserAutomationEngineActionResultV1Schema,
  BrowserAutomationCancelActiveInputV1Schema,
  BrowserAutomationCancelActiveResultV1Schema as BrowserAutomationEngineCancelActiveResultV1Schema,
  BrowserAutomationInterruptedResultV1Schema,
  BrowserAutomationTimelineV1Schema,
} from '../../browser/automation/v1.js';
import type { BrowserAutomationActionKindV1 } from '../../browser/automation/v1.js';
import {
  BrowserCloseViewCommandV1Schema,
  BrowserCommandDispatchResultV1Schema,
  BrowserWorkspaceOpenResultV1Schema,
  BrowserFocusViewCommandV1Schema,
  BrowserGoBackCommandV1Schema,
  BrowserGoForwardCommandV1Schema,
  BrowserNavigateCommandV1Schema,
  BrowserOpenViewCommandV1Schema,
  BrowserOpenViewInProgressV1Schema,
  BrowserReloadCommandV1Schema,
  BrowserSetTargetCommandV1Schema,
  BrowserStopCommandV1Schema,
  BrowserTakeControlCommandV1Schema,
  BrowserHandBackCommandV1Schema,
} from '../../browser/control/v1.js';
import {
  BrowserAnnotationStyleIntentV1Schema,
  BrowserAnnotationRectV1Schema,
  BrowserAnnotationDraftStrokeV1Schema,
  BrowserAnnotationDraftTargetV1Schema,
  BrowserAnnotationDraftMarkHandleV1Schema,
  BrowserContextAttachmentV1Schema,
  BrowserContextCommandV1Schema,
  BrowserContextRouteResultV1Schema,
} from '../../browser/context/v1.js';
import {
  BrowserDiagnosticsElementPickerRequestV1Schema,
  BrowserDiagnosticsElementPickerResultV1Schema,
  BrowserDiagnosticsEvalRequestV1Schema,
  BrowserDiagnosticsEvalResultV1Schema,
  BrowserDiagnosticsGetPropertiesRequestV1Schema,
  BrowserDiagnosticsGetPropertiesResultV1Schema,
  BrowserDiagnosticsReleaseObjectGroupRequestV1Schema,
  BrowserDiagnosticsReleaseObjectGroupResultV1Schema,
  BrowserDiagnosticsSnapshotV1Schema,
} from '../../browser/diagnostics/v1.js';
import {
  BrowserRecordingSessionV1Schema,
  DaemonBrowserRecordingCancelInputV1Schema,
  DaemonBrowserRecordingCleanupInputV1Schema,
  DaemonBrowserRecordingCleanupResultV1Schema,
  DaemonBrowserRecordingListInputV1Schema,
  DaemonBrowserRecordingStartInputV1Schema,
  DaemonBrowserRecordingStartResultV1Schema,
  DaemonBrowserRecordingStatusInputV1Schema,
  DaemonBrowserRecordingStopInputV1Schema,
  DaemonBrowserRecordingStopResultV1Schema,
  DaemonBrowserRecordingTerminalResultV1Schema,
} from '../../browser/recording/v1.js';
import type { RuntimeActionSpecFamily } from './common.js';
import { BrowserViewTargetV1Schema } from '../../browser/target/v1.js';

const BrowserAutomationActionResultV1Schema = lazyZodSchema(() => z.union([
  BrowserAutomationEngineActionResultV1Schema, BrowserAutomationInterruptedResultV1Schema,
]));
const BrowserAutomationCancelActiveResultV1Schema = lazyZodSchema(() => z.union([
  BrowserAutomationEngineCancelActiveResultV1Schema, BrowserAutomationInterruptedResultV1Schema,
]));

const BrowserDiagnosticsClearResultV1Schema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(true),
}));

const BrowserDiagnosticsPauseResultV1Schema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(true),
  status: z.literal('paused'),
  viewId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
}));

const BrowserDiagnosticsResumeResultV1Schema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(true),
  status: z.literal('resumed'),
  viewId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
}));

const BrowserRecordingAttachToComposerResultV1Schema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(true),
  attachmentId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
}));

const BrowserRecordingListResultV1Schema = lazyZodSchema(() => z.array(BrowserRecordingSessionV1Schema));

const BrowserSandboxInstallInputV1Schema = lazyZodSchema(() => z.strictObject({ machineId: z.string().check(z.trim(), z.minLength(1)) }));
const BrowserSandboxInstallResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('installed') }),
  z.strictObject({ status: z.literal('failed'), code: z.enum([
    'platform_unsupported', 'managed_browser_unavailable', 'managed_browser_install_failed',
    'os_authorization_required', 'sandbox_install_failed', 'cancelled',
  ]) }),
]));

type BrowserRuntimeActionId = Extract<RuntimeActionIdV1, `browser.${string}`>;

function createBrowserAutomationActionInputSchema<
  const TActionKind extends BrowserAutomationActionKindV1,
>(actionKind: TActionKind) {
  return lazyZodSchema(() => z.intersection(
    BrowserAutomationActionRequestV1Schema,
    z.looseObject({ actionKind: z.literal(actionKind) }),
  ));
}

const RuntimeBrowserViewInputSchema = lazyZodSchema(() => z.looseObject({
    browserSessionId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    viewId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
  }));

const RuntimeBrowserViewEffectInputSchema = lazyZodSchema(() => z.strictObject({
  commandId: BrowserOpenViewCommandV1Schema.shape.commandId,
  ...RuntimeBrowserViewInputSchema.shape,
}));

const RuntimeBrowserContextActionInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(z.extend(RuntimeBrowserViewInputSchema, {
  navigationGeneration: z.optional(z.number().check(z.int(), z.nonnegative())),
  contextId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
  annotationId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
  command: z.optional(BrowserContextCommandV1Schema),
  comment: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(2048))),
  styleIntent: z.optional(BrowserAnnotationStyleIntentV1Schema),
})));

const RuntimeBrowserRecordingAttachInputSchema = lazyZodSchema(() => z.looseObject({
    recordingId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    sessionId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
  }));

const RuntimeMountedBrowserContextInputSchema = lazyZodSchema(() => z.strictObject({
  ...RuntimeBrowserViewInputSchema.shape,
  navigationGeneration: z.number().check(z.int(), z.nonnegative()),
}));

const RuntimeBrowserContextAttachInputSchema = lazyZodSchema(() => z.union([
  z.strictObject({ ...RuntimeMountedBrowserContextInputSchema.shape, source: z.literal('activePage') }),
  z.looseObject({ ...RuntimeBrowserContextActionInputSchema.shape, source: z.optional(z.never()) }),
]));

const BrowserAnnotationDraftCommitResultSchema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  actionId: z.literal('browser.context.annotation.attachDraft'),
  status: z.literal('committed'),
  annotationId: RuntimeBrowserViewInputSchema.shape.viewId,
  itemIds: z.array(RuntimeBrowserViewInputSchema.shape.viewId),
}));

export const BROWSER_ANNOTATION_DRAFT_ACTION_IDS = [
  'browser.context.annotation.addDraftTarget', 'browser.context.annotation.addDraftRegion',
  'browser.context.annotation.addDraftStroke', 'browser.context.annotation.removeDraftTarget',
  'browser.context.annotation.setDraftComment',
] as const satisfies readonly RuntimeActionIdV1[];

function draftUpdatedResultSchema<const T extends typeof BROWSER_ANNOTATION_DRAFT_ACTION_IDS[number]>(actionId: T) {
  return lazyZodSchema(() => z.strictObject({ v: z.literal(1), actionId: z.literal(actionId), status: z.literal('draftUpdated'),
    marks: z.array(BrowserAnnotationDraftMarkHandleV1Schema) }));
}

function draftHintFields(field: ActionInputFieldHint): readonly ActionInputFieldHint[] {
  return [
    { path: 'browserSessionId', title: 'Browser session', widget: 'text', required: true },
    { path: 'viewId', title: 'Browser view', widget: 'text', required: true },
    { path: 'navigationGeneration', title: 'Observed navigation', widget: 'number', required: true },
    field,
  ];
}

export const BROWSER_RUNTIME_ACTION_INPUT_HINT_FIELDS: Readonly<Partial<Record<RuntimeActionIdV1, readonly ActionInputFieldHint[]>>> = {
  'browser.view.openDevtools': [
    { path: 'browserSessionId', title: 'Browser session', widget: 'text', required: true },
    { path: 'viewId', title: 'Browser view', widget: 'text', required: true },
    { path: 'commandId', title: 'Command', widget: 'text', required: true },
  ],
  'browser.context.annotation.addDraftTarget': draftHintFields({ path: 'target', title: 'Element', widget: 'json', required: true }),
  'browser.context.annotation.addDraftRegion': draftHintFields({ path: 'rect', title: 'Region', widget: 'json', required: true }),
  'browser.context.annotation.addDraftStroke': draftHintFields({ path: 'stroke', title: 'Stroke', widget: 'json', required: true }),
  'browser.context.annotation.removeDraftTarget': draftHintFields({ path: 'draftId', title: 'Mark', widget: 'text', required: true }),
  'browser.context.annotation.setDraftComment': draftHintFields({ path: 'comment', title: 'Comment (null clears)', widget: 'text', required: true }),
};

export const BROWSER_RUNTIME_ACTION_TITLES: Readonly<Partial<Record<RuntimeActionIdV1, string>>> = Object.freeze({
  'browser.profile.logins.import': 'Import browser logins',
  'browser.sandbox.install': 'Install managed browser sandbox permission',
  'browser.control.takeControl': 'Yield browser control to the human',
  'browser.control.handBack': 'Return browser control to the Session',
  'browser.workspace.open': 'Open browser target in workspace',
  'browser.view.open': 'Open browser view',
  'browser.view.openExternal': 'Open browser page in the system browser',
  'browser.view.openDevtools': 'Open native browser developer tools',
  'browser.view.close': 'Close browser view',
  'browser.view.focus': 'Focus browser view',
  'browser.target.set': 'Set browser target',
  'browser.navigate': 'Navigate browser',
  'browser.reload': 'Reload browser',
  'browser.goBack': 'Go back in browser',
  'browser.goForward': 'Go forward in browser',
  'browser.stop': 'Stop browser load',
  'browser.diagnostics.snapshot': 'Get browser diagnostics snapshot',
  'browser.diagnostics.clear': 'Clear browser diagnostics',
  'browser.diagnostics.pause': 'Pause browser diagnostics',
  'browser.diagnostics.resume': 'Resume browser diagnostics',
  'browser.diagnostics.eval': 'Evaluate browser diagnostics expression',
  'browser.diagnostics.getProperties': 'Get browser remote object properties',
  'browser.diagnostics.releaseObjectGroup': 'Release browser remote object group',
  'browser.diagnostics.elementPicker.start': 'Start browser element picker',
  'browser.diagnostics.elementPicker.cancel': 'Cancel browser element picker',
  'browser.context.capturePage': 'Capture browser page context',
  'browser.context.captureScreenshot': 'Capture browser screenshot context',
  'browser.context.captureSelectedElement': 'Capture selected browser element',
  'browser.context.captureNetworkSummary': 'Capture browser network summary',
  'browser.context.captureConsoleSummary': 'Capture browser console summary',
  'browser.context.annotation.start': 'Start browser annotation',
  'browser.context.annotation.cancel': 'Cancel browser annotation',
  'browser.context.annotation.captureRegion': 'Capture browser annotation region',
  'browser.context.annotation.captureElement': 'Capture browser annotation element',
  'browser.context.annotation.attachComment': 'Attach browser annotation comment',
  'browser.context.annotation.attachStroke': 'Attach browser annotation stroke',
  'browser.context.annotation.attachStyleIntent': 'Attach browser annotation style intent',
  'browser.context.annotation.attachDraft': 'Attach browser annotation draft',
  'browser.context.annotation.addDraftTarget': 'Add an element to the annotation draft',
  'browser.context.annotation.addDraftRegion': 'Add a region to the annotation draft',
  'browser.context.annotation.addDraftStroke': 'Add a stroke to the annotation draft',
  'browser.context.annotation.removeDraftTarget': 'Remove an annotation draft mark',
  'browser.context.annotation.setDraftComment': 'Set the annotation draft comment',
  'browser.context.attachToComposer': 'Attach browser context to composer',
  'browser.context.attachToAgentTurn': 'Attach browser context to agent turn',
  'browser.context.clear': 'Clear browser context',
  'browser.automation.status': 'Get browser automation status',
  'browser.automation.snapshot': 'Capture browser automation snapshot',
  'browser.automation.semanticSnapshot': 'Capture browser semantic snapshot',
  'browser.automation.queryElements': 'Query browser elements',
  'browser.automation.waitFor': 'Wait for browser condition',
  'browser.automation.timeline.get': 'Get browser automation timeline',
  'browser.automation.cancelActive': 'Cancel active browser automation',
  'browser.automation.navigate': 'Automate browser navigation',
  'browser.automation.reload': 'Automate browser reload',
  'browser.automation.goBack': 'Automate browser back navigation',
  'browser.automation.goForward': 'Automate browser forward navigation',
  'browser.automation.click': 'Click browser element',
  'browser.automation.tap': 'Tap browser surface',
  'browser.automation.type': 'Type into browser',
  'browser.automation.press': 'Press browser key',
  'browser.automation.scroll': 'Scroll browser surface',
  'browser.automation.hover': 'Hover browser element',
  'browser.automation.focus': 'Focus browser element',
  'browser.automation.select': 'Select browser option',
  'browser.automation.setValue': 'Set browser field value',
  'browser.automation.secret.fill': 'Request confidential browser credential entry',
  'browser.automation.upload': 'Upload files to browser input',
  'browser.automation.drag': 'Drag between browser elements',
  'browser.recording.start': 'Start browser recording',
  'browser.recording.stop': 'Stop browser recording',
  'browser.recording.cancel': 'Cancel browser recording',
  'browser.recording.status': 'Get browser recording status',
  'browser.recording.listForView': 'List browser recordings for view',
  'browser.recording.discard': 'Discard browser recording',
  'browser.recording.cleanupExpired': 'Clean up expired browser recordings',
  'browser.recording.attachToComposer': 'Attach browser recording to composer',
});

export const BROWSER_RUNTIME_ACTION_DESCRIPTIONS: Readonly<Partial<Record<RuntimeActionIdV1, string>>> = Object.freeze({
  'browser.profile.logins.import': 'Copy selected logins into a managed browser profile. The Session agent and anyone who can drive this browser can use these logins.',
  'browser.sandbox.install': 'Install an executable-scoped AppArmor userns profile for this machine’s managed Chromium. Approval is required by default; the human must separately authorize sudo on that machine.',
  'browser.control.takeControl': 'Interrupt browser automation and yield control to the human through the existing controller owner.',
  'browser.control.handBack': 'Return browser control to the Session after accepted input settles. The agent must observe again before its next mutation.',
  'browser.workspace.open': 'Open a target in the exact answering-client workspace, before a Browser view exists. Requires the current Home and mounted workspace owner.',
  'browser.view.open': 'Open a browser view inside an existing browser session.',
  'browser.view.openExternal': 'Open the exact mounted page in the answering client\'s system browser without replacing its view.',
  'browser.view.openDevtools': 'Open native developer tools for the exact mounted desktop browser view when its engine supports them.',
  'browser.view.close': 'Close a browser view and detach it from its session.',
  'browser.view.focus': 'Bring a browser view to the foreground of its session.',
  'browser.target.set': 'Point a browser view at a launch target or URL.',
  'browser.navigate': 'Navigate a browser view to a URL.',
  'browser.reload': 'Reload the current page in a browser view.',
  'browser.goBack': 'Navigate back in a browser view history.',
  'browser.goForward': 'Navigate forward in a browser view history.',
  'browser.stop': 'Stop the in-progress page load in a browser view.',
  'browser.context.capturePage': 'Capture the current browser page as shareable context.',
  'browser.context.captureScreenshot': 'Capture a screenshot of the browser view as context.',
  'browser.context.captureSelectedElement': 'Capture the selected browser element as context.',
  'browser.context.captureNetworkSummary': 'Capture a redacted summary of recent browser network activity.',
  'browser.context.captureConsoleSummary': 'Capture a redacted summary of recent browser console output.',
  'browser.context.annotation.start': 'Start an in-page browser annotation session.',
  'browser.context.annotation.cancel': 'Cancel the active browser annotation session.',
  'browser.context.annotation.captureRegion': 'Capture a cropped region for the active browser annotation.',
  'browser.context.annotation.captureElement': 'Capture a selected element for the active browser annotation.',
  'browser.context.annotation.attachComment': 'Attach a comment to the active browser annotation.',
  'browser.context.annotation.attachStroke': 'Attach a freehand stroke to the active browser annotation.',
  'browser.context.annotation.attachStyleIntent': 'Set the drawing style for the active browser annotation.',
  'browser.context.annotation.attachDraft': 'Capture and attach the exact mounted view\'s annotation draft to its Session composer.',
  'browser.context.annotation.addDraftTarget': 'Add the selected element to the current mounted annotation draft.',
  'browser.context.annotation.addDraftRegion': 'Add a region in CSS viewport coordinates to the current mounted annotation draft.',
  'browser.context.annotation.addDraftStroke': 'Add a stroke in CSS viewport coordinates to the current mounted annotation draft.',
  'browser.context.annotation.removeDraftTarget': 'Remove one element, region or stroke by its draft mark id.',
  'browser.context.annotation.setDraftComment': 'Set the current annotation draft comment; null or an empty string clears it.',
  'browser.automation.status': 'Read the current browser automation status.',
  'browser.automation.snapshot': 'Capture an automation snapshot of the browser view.',
  'browser.automation.semanticSnapshot': 'Capture a semantic accessibility snapshot of the browser view.',
  'browser.automation.queryElements': 'Query elements in the browser view by selector or role.',
  'browser.automation.waitFor': 'Wait for a browser condition before continuing automation.',
  'browser.automation.timeline.get': 'Read the recorded browser automation action timeline.',
  'browser.automation.cancelActive': 'Cancel the active browser automation operation.',
  'browser.automation.navigate': 'Automate navigation of the browser view to a URL.',
  'browser.automation.reload': 'Automate reloading the current browser page.',
  'browser.automation.goBack': 'Automate navigating back in the browser view.',
  'browser.automation.goForward': 'Automate navigating forward in the browser view.',
  'browser.automation.click': 'Automate clicking a browser element.',
  'browser.automation.tap': 'Automate tapping the browser surface.',
  'browser.automation.type': 'Automate typing text into the browser view.',
  'browser.automation.press': 'Automate pressing a key in the browser view.',
  'browser.automation.scroll': 'Automate scrolling the browser surface.',
  'browser.automation.hover': 'Automate hovering over a browser element.',
  'browser.automation.focus': 'Automate focusing a browser element.',
  'browser.automation.select': 'Automate selecting an option in the browser view.',
  'browser.automation.setValue': 'Automate setting the value of a browser field.',
  'browser.automation.secret.fill': 'Request a human credential choice for the exact observed browser field and origin. Confidential entry never accepts a value in Action arguments or returns a browser result bag.',
  'browser.automation.upload': 'Attach one or more files to a browser file input.',
  'browser.automation.drag': 'Drag a browser element onto a drop target.',
  'browser.recording.attachToComposer': 'Attach a captured browser recording to the message composer.',
  'browser.diagnostics.snapshot': 'Read what the browser view has logged so far: console messages, errors and network requests.',
  'browser.diagnostics.clear': 'Empty the collected console and network log of a browser view.',
  'browser.diagnostics.pause': 'Stop collecting console and network activity for a browser view for now.',
  'browser.diagnostics.resume': 'Start collecting console and network activity for a browser view again.',
  'browser.diagnostics.eval': 'Run a piece of JavaScript in the page and read the result.',
  'browser.diagnostics.getProperties': 'Look inside a value the page returned, such as an object\'s fields.',
  'browser.diagnostics.releaseObjectGroup': 'Let go of page values that were kept for inspection.',
  'browser.diagnostics.elementPicker.start': 'Start picking an element by pointing at it in the page.',
  'browser.diagnostics.elementPicker.cancel': 'Stop picking an element without choosing one.',
  'browser.context.attachToComposer': 'Add captured browser context to the message you are writing. source="activePage" captures and attaches the exact mounted page, qualified by browserSessionId, viewId and navigationGeneration.',
  'browser.context.attachToAgentTurn': 'Give what you captured from the browser to the agent with its next turn.',
  'browser.context.clear': 'Throw away what was captured from the browser and not yet sent.',
  'browser.recording.start': 'Start recording a video of a browser view.',
  'browser.recording.stop': 'Finish a browser recording and keep it.',
  'browser.recording.cancel': 'Stop a browser recording and throw it away.',
  'browser.recording.status': 'See whether a browser view is being recorded.',
  'browser.recording.listForView': 'See the recordings made of a browser view.',
  'browser.recording.discard': 'Delete a browser recording.',
  'browser.recording.cleanupExpired': 'Delete browser recordings that are past the time they are kept for.',
});

/**
 * One concrete schema row per backed browser Action. This is deliberately a
 * data projection rather than a prefix switch so a newly public Action keeps
 * its exact Zod input/output carrier in generated API and Plugin maps.
 */
export const BROWSER_RUNTIME_ACTION_INPUT_SCHEMAS = Object.freeze({
  'browser.profile.logins.import': BrowserProfileLoginsImportV1Schema,
  'browser.sandbox.install': BrowserSandboxInstallInputV1Schema,
  'browser.control.takeControl': BrowserTakeControlCommandV1Schema,
  'browser.control.handBack': BrowserHandBackCommandV1Schema,
  'browser.workspace.open': lazyZodSchema(() => z.strictObject({
    scopeId: z.string().check(z.trim(), z.minLength(1)),
    commandId: BrowserOpenViewCommandV1Schema.shape.commandId,
    target: BrowserViewTargetV1Schema,
  })),
  'browser.view.open': BrowserOpenViewCommandV1Schema,
  'browser.view.openExternal': RuntimeBrowserViewEffectInputSchema,
  'browser.view.openDevtools': RuntimeBrowserViewEffectInputSchema,
  'browser.view.close': BrowserCloseViewCommandV1Schema,
  'browser.view.focus': BrowserFocusViewCommandV1Schema,
  'browser.target.set': BrowserSetTargetCommandV1Schema,
  'browser.navigate': BrowserNavigateCommandV1Schema,
  'browser.reload': BrowserReloadCommandV1Schema,
  'browser.goBack': BrowserGoBackCommandV1Schema,
  'browser.goForward': BrowserGoForwardCommandV1Schema,
  'browser.stop': BrowserStopCommandV1Schema,
  'browser.diagnostics.snapshot': RuntimeBrowserViewInputSchema,
  'browser.diagnostics.clear': RuntimeBrowserViewInputSchema,
  'browser.diagnostics.pause': RuntimeBrowserViewInputSchema,
  'browser.diagnostics.resume': RuntimeBrowserViewInputSchema,
  'browser.diagnostics.eval': lazyZodSchema(() => z.strictObject({ ...BrowserDiagnosticsEvalRequestV1Schema.shape, browserSessionId: RuntimeBrowserViewInputSchema.shape.browserSessionId })),
  'browser.diagnostics.getProperties': lazyZodSchema(() => z.strictObject({ ...BrowserDiagnosticsGetPropertiesRequestV1Schema.shape, browserSessionId: RuntimeBrowserViewInputSchema.shape.browserSessionId })),
  'browser.diagnostics.releaseObjectGroup': lazyZodSchema(() => z.strictObject({ ...BrowserDiagnosticsReleaseObjectGroupRequestV1Schema.shape, browserSessionId: RuntimeBrowserViewInputSchema.shape.browserSessionId })),
  'browser.diagnostics.elementPicker.start': lazyZodSchema(() => z.strictObject({ ...BrowserDiagnosticsElementPickerRequestV1Schema.shape, browserSessionId: RuntimeBrowserViewInputSchema.shape.browserSessionId, action: z.literal('start') })),
  'browser.diagnostics.elementPicker.cancel': lazyZodSchema(() => z.strictObject({ ...BrowserDiagnosticsElementPickerRequestV1Schema.shape, browserSessionId: RuntimeBrowserViewInputSchema.shape.browserSessionId, action: z.literal('cancel') })),
  'browser.context.capturePage': RuntimeBrowserContextActionInputSchema,
  'browser.context.captureScreenshot': RuntimeBrowserContextActionInputSchema,
  'browser.context.captureSelectedElement': RuntimeBrowserContextActionInputSchema,
  'browser.context.captureNetworkSummary': RuntimeBrowserContextActionInputSchema,
  'browser.context.captureConsoleSummary': RuntimeBrowserContextActionInputSchema,
  'browser.context.annotation.start': RuntimeBrowserContextActionInputSchema,
  'browser.context.annotation.cancel': RuntimeBrowserContextActionInputSchema,
  'browser.context.annotation.captureRegion': RuntimeBrowserContextActionInputSchema,
  'browser.context.annotation.captureElement': RuntimeBrowserContextActionInputSchema,
  'browser.context.annotation.attachComment': RuntimeBrowserContextActionInputSchema,
  'browser.context.annotation.attachStroke': RuntimeBrowserContextActionInputSchema,
  'browser.context.annotation.attachStyleIntent': RuntimeBrowserContextActionInputSchema,
  'browser.context.annotation.attachDraft': RuntimeMountedBrowserContextInputSchema,
  'browser.context.annotation.addDraftTarget': lazyZodSchema(() => z.strictObject({ ...RuntimeMountedBrowserContextInputSchema.shape, target: BrowserAnnotationDraftTargetV1Schema })),
  'browser.context.annotation.addDraftRegion': lazyZodSchema(() => z.strictObject({ ...RuntimeMountedBrowserContextInputSchema.shape, rect: BrowserAnnotationRectV1Schema })),
  'browser.context.annotation.addDraftStroke': lazyZodSchema(() => z.strictObject({ ...RuntimeMountedBrowserContextInputSchema.shape, stroke: BrowserAnnotationDraftStrokeV1Schema })),
  'browser.context.annotation.removeDraftTarget': lazyZodSchema(() => z.strictObject({ ...RuntimeMountedBrowserContextInputSchema.shape, draftId: RuntimeBrowserViewInputSchema.shape.viewId })),
  'browser.context.annotation.setDraftComment': lazyZodSchema(() => z.strictObject({ ...RuntimeMountedBrowserContextInputSchema.shape, comment: z.nullable(z.string().check(z.maxLength(2048))) })),
  'browser.context.attachToComposer': RuntimeBrowserContextAttachInputSchema,
  'browser.context.attachToAgentTurn': RuntimeBrowserContextActionInputSchema,
  'browser.context.clear': RuntimeBrowserContextActionInputSchema,
  'browser.automation.status': createBrowserAutomationActionInputSchema('getStatus'),
  'browser.automation.snapshot': createBrowserAutomationActionInputSchema('snapshot'),
  'browser.automation.semanticSnapshot': createBrowserAutomationActionInputSchema('semanticSnapshot'),
  'browser.automation.queryElements': createBrowserAutomationActionInputSchema('queryElements'),
  'browser.automation.waitFor': createBrowserAutomationActionInputSchema('waitFor'),
  'browser.automation.timeline.get': createBrowserAutomationActionInputSchema('getActionTimeline'),
  'browser.automation.cancelActive': BrowserAutomationCancelActiveInputV1Schema,
  'browser.automation.navigate': createBrowserAutomationActionInputSchema('navigate'),
  'browser.automation.reload': createBrowserAutomationActionInputSchema('reload'),
  'browser.automation.goBack': createBrowserAutomationActionInputSchema('goBack'),
  'browser.automation.goForward': createBrowserAutomationActionInputSchema('goForward'),
  'browser.automation.click': createBrowserAutomationActionInputSchema('click'),
  'browser.automation.tap': createBrowserAutomationActionInputSchema('tap'),
  'browser.automation.type': createBrowserAutomationActionInputSchema('type'),
  'browser.automation.press': createBrowserAutomationActionInputSchema('press'),
  'browser.automation.scroll': createBrowserAutomationActionInputSchema('scroll'),
  'browser.automation.hover': createBrowserAutomationActionInputSchema('hover'),
  'browser.automation.focus': createBrowserAutomationActionInputSchema('focus'),
  'browser.automation.select': createBrowserAutomationActionInputSchema('select'),
  'browser.automation.setValue': createBrowserAutomationActionInputSchema('setValue'),
  'browser.automation.secret.fill': BrowserAutomationSecretFillRequestV1Schema,
  'browser.automation.upload': createBrowserAutomationActionInputSchema('upload'),
  'browser.automation.drag': createBrowserAutomationActionInputSchema('drag'),
  'browser.recording.start': DaemonBrowserRecordingStartInputV1Schema,
  'browser.recording.stop': DaemonBrowserRecordingStopInputV1Schema,
  'browser.recording.cancel': DaemonBrowserRecordingCancelInputV1Schema,
  'browser.recording.status': DaemonBrowserRecordingStatusInputV1Schema,
  'browser.recording.listForView': DaemonBrowserRecordingListInputV1Schema,
  'browser.recording.discard': DaemonBrowserRecordingCancelInputV1Schema,
  'browser.recording.cleanupExpired': DaemonBrowserRecordingCleanupInputV1Schema,
  'browser.recording.attachToComposer': RuntimeBrowserRecordingAttachInputSchema,
} as const satisfies Readonly<Record<BrowserRuntimeActionId, z.ZodMiniType>>);

// Keep declaration emission tied to the named schemas rather than expanding
// every nested Browser context/diagnostic schema into this lookup's declaration.
const browserRuntimeOutputGeneralSchemas: Readonly<{
  'browser.profile.logins.import': typeof BrowserProfileLoginsImportResultV1Schema;
  'browser.sandbox.install': typeof BrowserSandboxInstallResultV1Schema;
  'browser.control.takeControl': z.ZodMiniUnion<readonly [typeof BrowserCommandDispatchResultV1Schema, typeof BrowserAutomationInterruptedResultV1Schema]>;
  'browser.control.handBack': z.ZodMiniUnion<readonly [typeof BrowserCommandDispatchResultV1Schema, typeof BrowserAutomationInterruptedResultV1Schema]>;
  'browser.workspace.open': typeof BrowserWorkspaceOpenResultV1Schema;
  'browser.view.open': z.ZodMiniUnion<readonly [typeof BrowserCommandDispatchResultV1Schema, typeof BrowserOpenViewInProgressV1Schema]>;
  'browser.view.openExternal': typeof BrowserCommandDispatchResultV1Schema;
  'browser.view.openDevtools': typeof BrowserCommandDispatchResultV1Schema;
  'browser.view.close': typeof BrowserCommandDispatchResultV1Schema;
  'browser.view.focus': typeof BrowserCommandDispatchResultV1Schema;
  'browser.target.set': typeof BrowserCommandDispatchResultV1Schema;
  'browser.navigate': typeof BrowserCommandDispatchResultV1Schema;
  'browser.reload': typeof BrowserCommandDispatchResultV1Schema;
  'browser.goBack': typeof BrowserCommandDispatchResultV1Schema;
  'browser.goForward': typeof BrowserCommandDispatchResultV1Schema;
  'browser.stop': typeof BrowserCommandDispatchResultV1Schema;
  'browser.diagnostics.snapshot': typeof BrowserDiagnosticsSnapshotV1Schema;
  'browser.diagnostics.clear': typeof BrowserDiagnosticsClearResultV1Schema;
  'browser.diagnostics.pause': typeof BrowserDiagnosticsPauseResultV1Schema;
  'browser.diagnostics.resume': typeof BrowserDiagnosticsResumeResultV1Schema;
  'browser.diagnostics.eval': typeof BrowserDiagnosticsEvalResultV1Schema;
  'browser.diagnostics.getProperties': typeof BrowserDiagnosticsGetPropertiesResultV1Schema;
  'browser.diagnostics.releaseObjectGroup': typeof BrowserDiagnosticsReleaseObjectGroupResultV1Schema;
  'browser.diagnostics.elementPicker.start': typeof BrowserDiagnosticsElementPickerResultV1Schema;
  'browser.diagnostics.elementPicker.cancel': typeof BrowserDiagnosticsElementPickerResultV1Schema;
  'browser.context.capturePage': typeof BrowserContextRouteResultV1Schema;
  'browser.context.captureScreenshot': typeof BrowserContextRouteResultV1Schema;
  'browser.context.captureSelectedElement': typeof BrowserContextRouteResultV1Schema;
  'browser.context.captureNetworkSummary': typeof BrowserContextRouteResultV1Schema;
  'browser.context.captureConsoleSummary': typeof BrowserContextRouteResultV1Schema;
  'browser.context.annotation.start': typeof BrowserContextRouteResultV1Schema;
  'browser.context.annotation.cancel': typeof BrowserContextRouteResultV1Schema;
  'browser.context.annotation.captureRegion': typeof BrowserContextRouteResultV1Schema;
  'browser.context.annotation.captureElement': typeof BrowserContextRouteResultV1Schema;
  'browser.context.annotation.attachComment': typeof BrowserContextRouteResultV1Schema;
  'browser.context.annotation.attachStroke': typeof BrowserContextRouteResultV1Schema;
  'browser.context.annotation.attachStyleIntent': typeof BrowserContextRouteResultV1Schema;
  'browser.context.annotation.attachDraft': typeof BrowserAnnotationDraftCommitResultSchema;
  'browser.context.annotation.addDraftTarget': ReturnType<typeof draftUpdatedResultSchema<'browser.context.annotation.addDraftTarget'>>;
  'browser.context.annotation.addDraftRegion': ReturnType<typeof draftUpdatedResultSchema<'browser.context.annotation.addDraftRegion'>>;
  'browser.context.annotation.addDraftStroke': ReturnType<typeof draftUpdatedResultSchema<'browser.context.annotation.addDraftStroke'>>;
  'browser.context.annotation.removeDraftTarget': ReturnType<typeof draftUpdatedResultSchema<'browser.context.annotation.removeDraftTarget'>>;
  'browser.context.annotation.setDraftComment': ReturnType<typeof draftUpdatedResultSchema<'browser.context.annotation.setDraftComment'>>;
  'browser.context.attachToComposer': typeof BrowserContextAttachmentV1Schema;
  'browser.context.attachToAgentTurn': typeof BrowserContextAttachmentV1Schema;
  'browser.context.clear': typeof BrowserContextRouteResultV1Schema;
}> = {
  'browser.profile.logins.import': BrowserProfileLoginsImportResultV1Schema,
  'browser.sandbox.install': BrowserSandboxInstallResultV1Schema,
  'browser.control.takeControl': z.union([BrowserCommandDispatchResultV1Schema, BrowserAutomationInterruptedResultV1Schema]),
  'browser.control.handBack': z.union([BrowserCommandDispatchResultV1Schema, BrowserAutomationInterruptedResultV1Schema]),
  'browser.workspace.open': BrowserWorkspaceOpenResultV1Schema,
  'browser.view.open': z.union([BrowserCommandDispatchResultV1Schema, BrowserOpenViewInProgressV1Schema]),
  'browser.view.openExternal': BrowserCommandDispatchResultV1Schema,
  'browser.view.openDevtools': BrowserCommandDispatchResultV1Schema,
  'browser.view.close': BrowserCommandDispatchResultV1Schema,
  'browser.view.focus': BrowserCommandDispatchResultV1Schema,
  'browser.target.set': BrowserCommandDispatchResultV1Schema,
  'browser.navigate': BrowserCommandDispatchResultV1Schema,
  'browser.reload': BrowserCommandDispatchResultV1Schema,
  'browser.goBack': BrowserCommandDispatchResultV1Schema,
  'browser.goForward': BrowserCommandDispatchResultV1Schema,
  'browser.stop': BrowserCommandDispatchResultV1Schema,
  'browser.diagnostics.snapshot': BrowserDiagnosticsSnapshotV1Schema,
  'browser.diagnostics.clear': BrowserDiagnosticsClearResultV1Schema,
  'browser.diagnostics.pause': BrowserDiagnosticsPauseResultV1Schema,
  'browser.diagnostics.resume': BrowserDiagnosticsResumeResultV1Schema,
  'browser.diagnostics.eval': BrowserDiagnosticsEvalResultV1Schema,
  'browser.diagnostics.getProperties': BrowserDiagnosticsGetPropertiesResultV1Schema,
  'browser.diagnostics.releaseObjectGroup': BrowserDiagnosticsReleaseObjectGroupResultV1Schema,
  'browser.diagnostics.elementPicker.start': BrowserDiagnosticsElementPickerResultV1Schema,
  'browser.diagnostics.elementPicker.cancel': BrowserDiagnosticsElementPickerResultV1Schema,
  'browser.context.capturePage': BrowserContextRouteResultV1Schema,
  'browser.context.captureScreenshot': BrowserContextRouteResultV1Schema,
  'browser.context.captureSelectedElement': BrowserContextRouteResultV1Schema,
  'browser.context.captureNetworkSummary': BrowserContextRouteResultV1Schema,
  'browser.context.captureConsoleSummary': BrowserContextRouteResultV1Schema,
  'browser.context.annotation.start': BrowserContextRouteResultV1Schema,
  'browser.context.annotation.cancel': BrowserContextRouteResultV1Schema,
  'browser.context.annotation.captureRegion': BrowserContextRouteResultV1Schema,
  'browser.context.annotation.captureElement': BrowserContextRouteResultV1Schema,
  'browser.context.annotation.attachComment': BrowserContextRouteResultV1Schema,
  'browser.context.annotation.attachStroke': BrowserContextRouteResultV1Schema,
  'browser.context.annotation.attachStyleIntent': BrowserContextRouteResultV1Schema,
  'browser.context.annotation.attachDraft': BrowserAnnotationDraftCommitResultSchema,
  'browser.context.annotation.addDraftTarget': draftUpdatedResultSchema('browser.context.annotation.addDraftTarget'),
  'browser.context.annotation.addDraftRegion': draftUpdatedResultSchema('browser.context.annotation.addDraftRegion'),
  'browser.context.annotation.addDraftStroke': draftUpdatedResultSchema('browser.context.annotation.addDraftStroke'),
  'browser.context.annotation.removeDraftTarget': draftUpdatedResultSchema('browser.context.annotation.removeDraftTarget'),
  'browser.context.annotation.setDraftComment': draftUpdatedResultSchema('browser.context.annotation.setDraftComment'),
  'browser.context.attachToComposer': BrowserContextAttachmentV1Schema,
  'browser.context.attachToAgentTurn': BrowserContextAttachmentV1Schema,
  'browser.context.clear': BrowserContextRouteResultV1Schema,
} as const;

const browserRuntimeOutputAutomationSchemas = {
  'browser.automation.status': BrowserAutomationActionResultV1Schema,
  'browser.automation.snapshot': BrowserAutomationActionResultV1Schema,
  'browser.automation.semanticSnapshot': BrowserAutomationActionResultV1Schema,
  'browser.automation.queryElements': BrowserAutomationActionResultV1Schema,
  'browser.automation.waitFor': BrowserAutomationActionResultV1Schema,
  'browser.automation.timeline.get': BrowserAutomationTimelineV1Schema,
  'browser.automation.cancelActive': BrowserAutomationCancelActiveResultV1Schema,
  'browser.automation.navigate': BrowserAutomationActionResultV1Schema,
  'browser.automation.reload': BrowserAutomationActionResultV1Schema,
  'browser.automation.goBack': BrowserAutomationActionResultV1Schema,
  'browser.automation.goForward': BrowserAutomationActionResultV1Schema,
  'browser.automation.click': BrowserAutomationActionResultV1Schema,
  'browser.automation.tap': BrowserAutomationActionResultV1Schema,
  'browser.automation.type': BrowserAutomationActionResultV1Schema,
  'browser.automation.press': BrowserAutomationActionResultV1Schema,
  'browser.automation.scroll': BrowserAutomationActionResultV1Schema,
  'browser.automation.hover': BrowserAutomationActionResultV1Schema,
  'browser.automation.focus': BrowserAutomationActionResultV1Schema,
  'browser.automation.select': BrowserAutomationActionResultV1Schema,
  'browser.automation.setValue': BrowserAutomationActionResultV1Schema,
  'browser.automation.secret.fill': SecretFillSettlementV1Schema,
  'browser.automation.upload': BrowserAutomationActionResultV1Schema,
  'browser.automation.drag': BrowserAutomationActionResultV1Schema,
  'browser.recording.start': DaemonBrowserRecordingStartResultV1Schema,
  'browser.recording.stop': DaemonBrowserRecordingStopResultV1Schema,
  'browser.recording.cancel': DaemonBrowserRecordingTerminalResultV1Schema,
  'browser.recording.status': z.nullable(BrowserRecordingSessionV1Schema),
  'browser.recording.listForView': BrowserRecordingListResultV1Schema,
  'browser.recording.discard': DaemonBrowserRecordingTerminalResultV1Schema,
  'browser.recording.cleanupExpired': DaemonBrowserRecordingCleanupResultV1Schema,
  'browser.recording.attachToComposer': BrowserRecordingAttachToComposerResultV1Schema,
} as const;

export const BROWSER_RUNTIME_ACTION_OUTPUT_SCHEMAS: Readonly<
  typeof browserRuntimeOutputGeneralSchemas & typeof browserRuntimeOutputAutomationSchemas
> = Object.freeze({
  ...browserRuntimeOutputGeneralSchemas,
  ...browserRuntimeOutputAutomationSchemas,
} as const satisfies Readonly<Record<BrowserRuntimeActionId, z.ZodMiniType>>);

/**
 * A view command is read by what it opens or does, never by the ids that route it: correlation and
 * discriminator operands, and the opening client's own plumbing, belong to Technical details.
 */
const BROWSER_VIEW_COMMAND_TECHNICAL_INPUT_PATHS = ['commandId', 'browserSessionId', 'viewId', 'kind'] as const;
const BROWSER_TARGETED_COMMAND_TECHNICAL_INPUT_PATHS = [...BROWSER_VIEW_COMMAND_TECHNICAL_INPUT_PATHS, 'target.targetId'] as const;
const BROWSER_APPROVAL_TECHNICAL_INPUT_PATHS = {
  'browser.view.openDevtools': ['commandId', 'browserSessionId', 'viewId'],
  'browser.view.open': [...BROWSER_TARGETED_COMMAND_TECHNICAL_INPUT_PATHS, 'platform', 'focus', 'openerViewId', 'currentUrlExpiresAt'],
  'browser.target.set': BROWSER_TARGETED_COMMAND_TECHNICAL_INPUT_PATHS,
  'browser.workspace.open': ['commandId', 'target.targetId'],
  'browser.view.close': BROWSER_VIEW_COMMAND_TECHNICAL_INPUT_PATHS,
  'browser.view.focus': BROWSER_VIEW_COMMAND_TECHNICAL_INPUT_PATHS,
  'browser.navigate': BROWSER_VIEW_COMMAND_TECHNICAL_INPUT_PATHS,
  'browser.reload': BROWSER_VIEW_COMMAND_TECHNICAL_INPUT_PATHS,
  'browser.goBack': BROWSER_VIEW_COMMAND_TECHNICAL_INPUT_PATHS,
  'browser.goForward': BROWSER_VIEW_COMMAND_TECHNICAL_INPUT_PATHS,
  'browser.stop': BROWSER_VIEW_COMMAND_TECHNICAL_INPUT_PATHS,
  'browser.control.takeControl': BROWSER_VIEW_COMMAND_TECHNICAL_INPUT_PATHS,
  'browser.control.handBack': BROWSER_VIEW_COMMAND_TECHNICAL_INPUT_PATHS,
} as const satisfies Readonly<Partial<Record<BrowserRuntimeActionId, readonly string[]>>>;

export const BROWSER_RUNTIME_ACTION_SPEC_FAMILY: Readonly<{
  confirmationFacts: NonNullable<RuntimeActionSpecFamily['confirmationFacts']>;
  approvalPolicies: NonNullable<RuntimeActionSpecFamily['approvalPolicies']>;
  approvalTechnicalInputPaths: typeof BROWSER_APPROVAL_TECHNICAL_INPUT_PATHS;
  titles: typeof BROWSER_RUNTIME_ACTION_TITLES;
  descriptions: typeof BROWSER_RUNTIME_ACTION_DESCRIPTIONS;
  inputSchemas: typeof BROWSER_RUNTIME_ACTION_INPUT_SCHEMAS;
  outputSchemas: typeof BROWSER_RUNTIME_ACTION_OUTPUT_SCHEMAS;
}> = Object.freeze({
  confirmationFacts: {
    'browser.recording.discard': { confirmVerb: { key: 'common.discard', fallback: 'Discard' }, irreversible: true },
  },
  approvalPolicies: {
    'browser.profile.logins.import': { agentDefault: 'authority' },
    'browser.view.openDevtools': { agentDefault: 'authority' },
    'browser.workspace.open': { uiConfirmation: 'direct' },
    'browser.view.open': { uiConfirmation: 'direct' },
    'browser.automation.cancelActive': { agentDefault: 'authority', requiredSurfaces: ['agent', 'mcp', 'plugin', 'api'] },
    'browser.control.takeControl': { agentDefault: 'authority' },
    'browser.control.handBack': { agentDefault: 'authority' },
    'browser.context.capturePage': { agentDefault: 'egress' },
    'browser.context.captureScreenshot': { agentDefault: 'egress' },
    'browser.context.captureSelectedElement': { agentDefault: 'egress' },
    'browser.context.captureNetworkSummary': { agentDefault: 'egress' },
    'browser.context.captureConsoleSummary': { agentDefault: 'egress' },
    'browser.context.annotation.captureRegion': { agentDefault: 'egress' },
    'browser.context.annotation.captureElement': { agentDefault: 'egress' },
    'browser.context.annotation.attachDraft': { agentDefault: 'egress' },
    'browser.context.attachToComposer': { agentDefault: 'egress' },
    'browser.context.attachToAgentTurn': { agentDefault: 'egress' },
    'browser.recording.attachToComposer': { agentDefault: 'egress' },
  },
  approvalTechnicalInputPaths: BROWSER_APPROVAL_TECHNICAL_INPUT_PATHS,
  titles: BROWSER_RUNTIME_ACTION_TITLES,
  descriptions: BROWSER_RUNTIME_ACTION_DESCRIPTIONS,
  inputSchemas: BROWSER_RUNTIME_ACTION_INPUT_SCHEMAS,
  outputSchemas: BROWSER_RUNTIME_ACTION_OUTPUT_SCHEMAS,
} satisfies RuntimeActionSpecFamily);
