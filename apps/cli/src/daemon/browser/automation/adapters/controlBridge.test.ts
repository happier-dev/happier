import type { BrowserCommandV1, BrowserContextSnapshotV1 } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { BrowserDaemonControlAdapter } from '../../control/types';
import type {
  BrowserSidecarCdpPageHandle,
  BrowserSidecarContextCaptureSurface,
} from '../../sidecar/controlAdapter';
import { createControlAdapterAutomationTransport } from './controlBridge';

type ControlBridgeInput = Parameters<typeof createControlAdapterAutomationTransport>[0] & {
  browserContext?: {
    captureSnapshot?: (input: unknown) => Promise<unknown>;
  };
};

function controlAdapter(overrides: Partial<BrowserDaemonControlAdapter> = {}): BrowserDaemonControlAdapter {
  return {
    adapterKind: 'chromiumSidecar',
    ownsView: vi.fn(() => true),
    supportsOpenView: vi.fn(() => false),
    dispatchCommand: vi.fn(async (command: BrowserCommandV1) => ({
      v: 1 as const,
      commandId: command.commandId,
      status: 'dispatched' as const,
      adapterKind: 'chromiumSidecar' as const,
      events: [],
    })),
    ...overrides,
  };
}

const view = { browserSessionId: 'browser_session_1', viewId: 'view_1' } as const;
const HANDLE: BrowserSidecarCdpPageHandle = { targetId: 'target_1', sessionId: 'cdp_1' };

type Responder = (method: string, params: Record<string, unknown> | undefined) => unknown;

function fakeContextCapture(
  responder: Responder,
  resolveHandle: () => BrowserSidecarCdpPageHandle | null = () => HANDLE,
): {
  surface: BrowserSidecarContextCaptureSurface;
  calls: Array<{ method: string; params?: Record<string, unknown> }>;
} {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  return {
    calls,
    surface: {
      transport: {
        dispatchPageCommand: vi.fn(async (input: { method: string; params?: Record<string, unknown> }) => {
          calls.push({ method: input.method, ...(input.params ? { params: input.params } : {}) });
          return responder(input.method, input.params);
        }),
      },
      resolvePageHandle: resolveHandle,
    },
  };
}

type FakeBridgeElement = Readonly<{
  tagName: string;
  textContent: string;
  children: readonly FakeBridgeElement[];
  getAttribute(name: string): string | null;
  getBoundingClientRect(): Readonly<{ left: number; top: number; width: number; height: number }>;
  scrollIntoView(): void;
  focus(): void;
}>;

function bridgeElement(input: Readonly<{
  tagName: string;
  textContent: string;
  attributes?: Readonly<Record<string, string>>;
  rect: Readonly<{ left: number; top: number; width: number; height: number }>;
  children?: readonly FakeBridgeElement[];
}>): FakeBridgeElement {
  return {
    tagName: input.tagName.toUpperCase(),
    textContent: input.textContent,
    children: input.children ?? [],
    getAttribute(name) {
      return input.attributes?.[name] ?? null;
    },
    getBoundingClientRect() {
      return input.rect;
    },
    scrollIntoView() {
      return undefined;
    },
    focus() {
      return undefined;
    },
  };
}

function evaluateBridgeExpression(expression: string, documentValue: Readonly<{ querySelectorAll(selector: string): readonly FakeBridgeElement[] }>): unknown {
  return Function('document', `return ${expression};`)(documentValue);
}

function cdpEvaluateValue(value: unknown): Readonly<{ result: { type: string; value: unknown } }> {
  return {
    result: {
      type: typeof value === 'boolean' ? 'boolean' : typeof value === 'string' ? 'string' : 'object',
      value,
    },
  };
}

function createAggregateTextDocument(): Readonly<{
  button: FakeBridgeElement;
  documentValue: Readonly<{ querySelectorAll(selector: string): readonly FakeBridgeElement[] }>;
}> {
  const button = bridgeElement({
    tagName: 'button',
    textContent: 'Continue',
    attributes: { id: 'continue' },
    rect: { left: 20, top: 10, width: 50, height: 20 },
  });
  const main = bridgeElement({
    tagName: 'main',
    textContent: 'Choose an action Continue',
    rect: { left: 0, top: 0, width: 300, height: 200 },
    children: [button],
  });
  const body = bridgeElement({
    tagName: 'body',
    textContent: 'Welcome Choose an action Continue',
    rect: { left: 0, top: 0, width: 800, height: 600 },
    children: [main],
  });
  const html = bridgeElement({
    tagName: 'html',
    textContent: 'Welcome Choose an action Continue',
    rect: { left: 0, top: 0, width: 1000, height: 800 },
    children: [body],
  });
  return {
    button,
    documentValue: {
      querySelectorAll(selector) {
        return selector === '*' ? [html, body, main, button] : [];
      },
    },
  };
}

describe('control adapter automation transport bridge', () => {
  it('delegates ownsView to the control adapter', () => {
    const adapter = controlAdapter({ ownsView: vi.fn(() => false) });
    const transport = createControlAdapterAutomationTransport({ adapter });
    expect(transport.ownsView(view)).toBe(false);
  });

  it('forwards control commands to the control adapter', async () => {
    const adapter = controlAdapter();
    const transport = createControlAdapterAutomationTransport({ adapter });

    const command = {
      kind: 'navigate',
      commandId: 'cmd_1',
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
      url: 'https://x.test/',
    } satisfies BrowserCommandV1;
    const result = await transport.dispatchControlCommand(command);

    expect(result.status).toBe('dispatched');
    expect(adapter.dispatchCommand).toHaveBeenCalledWith(command);
  });

  it('fails page queries closed because the control adapter exposes no CDP query producer', async () => {
    const transport = createControlAdapterAutomationTransport({ adapter: controlAdapter() });

    const result = await transport.dispatchPageQuery({
      ...view,
      actionKind: 'snapshot',
      navigationGeneration: 1,
      payload: {},
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe('runtime_unavailable');
  });

  // MCH-3: read-only page queries ride the live CDP transport the control adapter opened.
  it('runs a snapshot query over the live CDP transport when a context-capture surface is present', async () => {
    const { surface, calls } = fakeContextCapture((method) => {
      if (method === 'Runtime.evaluate') {
        return { result: { type: 'string', value: '  Hello   page  ' } };
      }
      return {};
    });
    const transport = createControlAdapterAutomationTransport({ adapter: controlAdapter(), contextCapture: surface });

    const result = await transport.dispatchPageQuery({
      ...view,
      actionKind: 'snapshot',
      navigationGeneration: 1,
      payload: {},
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.data as { text?: string })?.text).toContain('Hello page');
    expect(calls.some((c) => c.method === 'Runtime.evaluate')).toBe(true);
  });

  it('routes the production snapshot verb through the rich browser-context snapshot producer', async () => {
    const { surface, calls } = fakeContextCapture((method) => {
      if (method === 'Runtime.evaluate') {
        return { result: { type: 'string', value: 'legacy text snapshot' } };
      }
      return {};
    });
    const captureSnapshot = vi.fn(async (): Promise<BrowserContextSnapshotV1> => ({
      v: 1 as const,
      contextId: 'browser_session_1 view_1 7',
      sourceViewId: 'view_1',
      sourceAdapterKind: 'chromiumSidecar' as const,
      fidelity: 'cdp' as const,
      capturedAtMs: 123,
      navigationGeneration: 7,
      redactionLevel: 'none' as const,
      visibleText: 'Welcome back',
      visibleTextTruncated: false,
      axNodes: [{ role: 'button', name: 'Submit' }],
      axNodesTruncated: false,
      interactiveElements: [
        { role: 'button', name: 'Submit', selector: '#submit', rect: { x: 10, y: 20, width: 80, height: 32 } },
      ],
      interactiveElementsTruncated: false,
      consoleSummary: '[log] ready',
      consoleTruncated: false,
      media: { mediaId: 'media_snapshot', mediaKind: 'image', width: 800, height: 600, sizeBytes: 4096 },
    }));
    const input = {
      adapter: controlAdapter(),
      contextCapture: surface,
      browserContext: { captureSnapshot },
    } satisfies ControlBridgeInput;
    const transport = createControlAdapterAutomationTransport(input);

    const result = await transport.dispatchPageQuery({
      ...view,
      actionKind: 'snapshot',
      navigationGeneration: 7,
      payload: {},
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(captureSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      browserSessionId: 'browser_session_1',
      viewId: 'view_1',
      navigationGeneration: 7,
    }));
    expect(result.data).toMatchObject({
      visibleText: 'Welcome back',
      axNodes: [{ role: 'button', name: 'Submit' }],
      interactiveElements: [
        { role: 'button', name: 'Submit', selector: '#submit' },
      ],
      consoleSummary: '[log] ready',
    });
    expect((result.data as { media?: { mediaId?: string } }).media?.mediaId).toBe('media_snapshot');
    expect(calls).toHaveLength(0);
  });

  // BA-2: the rich semantic snapshot returns interactiveElements[{role,name,selector,rect}] with
  // synthesized stable selectors so the agent can act by resilient locator, not coordinates.
  it('returns interactive elements with synthesized selector + rect for semanticSnapshot', async () => {
    const elements = [
      { role: 'button', name: 'Save', tag: 'button', selector: '#save', rect: { x: 10, y: 20, width: 80, height: 30 } },
      {
        role: 'textbox',
        name: 'Email',
        tag: 'input',
        selector: '[data-testid="email"]',
        rect: { x: 0, y: 60, width: 200, height: 24 },
      },
    ];
    const { surface, calls } = fakeContextCapture((method, params) => {
      if (method === 'Runtime.evaluate') {
        const expression = typeof params?.expression === 'string' ? params.expression : '';
        // The evaluator must synthesize selectors + rects in-page, not just role/name/tag.
        expect(expression).toContain('getBoundingClientRect');
        expect(expression).toContain('data-testid');
        return { result: { type: 'object', value: elements } };
      }
      return {};
    });
    const transport = createControlAdapterAutomationTransport({ adapter: controlAdapter(), contextCapture: surface });

    const result = await transport.dispatchPageQuery({
      ...view,
      actionKind: 'semanticSnapshot',
      navigationGeneration: 1,
      payload: {},
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as { elements?: ReadonlyArray<Record<string, unknown>> };
    expect(data.elements).toHaveLength(2);
    expect(data.elements?.[0]).toMatchObject({ role: 'button', name: 'Save', selector: '#save' });
    expect(data.elements?.[0]?.rect).toMatchObject({ x: 10, y: 20, width: 80, height: 30 });
    expect(data.elements?.[1]?.selector).toBe('[data-testid="email"]');
    expect(calls.some((c) => c.method === 'Runtime.evaluate')).toBe(true);
  });

  it('fails a query view_closed when the page handle cannot be resolved', async () => {
    const { surface } = fakeContextCapture(() => ({}), () => null);
    const transport = createControlAdapterAutomationTransport({ adapter: controlAdapter(), contextCapture: surface });

    const result = await transport.dispatchPageQuery({
      ...view,
      actionKind: 'getStatus',
      navigationGeneration: 0,
      payload: {},
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe('view_closed');
  });

  it('resolves semantic and CSS locators through the production query and wait paths', async () => {
    const { surface } = fakeContextCapture((method, params) => {
      if (method !== 'Runtime.evaluate') return {};
      const expression = typeof params?.expression === 'string' ? params.expression : '';
      if (expression.includes('querySelectorAll("role=') || expression.includes('querySelector("role=')) {
        return { result: { type: 'object', value: { error: 'invalid_selector' } } };
      }
      if (expression.includes('querySelectorAll("text=') || expression.includes('querySelector("text=')) {
        return { result: { type: 'object', value: { error: 'invalid_selector' } } };
      }
      if (expression.includes('querySelectorAll("data-testid=') || expression.includes('querySelector("data-testid=')) {
        return { result: { type: 'object', value: { error: 'invalid_selector' } } };
      }
      if (expression.includes('!!(') && expression.includes('getAttribute') && expression.includes('role')) {
        return { result: { type: 'boolean', value: true } };
      }
      if (expression.includes('getAttribute') && expression.includes('role') && expression.includes('Save')) {
        return { result: { type: 'object', value: { count: 1, elements: [{ tag: 'button', name: 'Save' }] } } };
      }
      if (expression.includes('textContent') && expression.includes('Continue')) {
        return { result: { type: 'object', value: { count: 1, elements: [{ tag: 'a', name: 'Continue' }] } } };
      }
      if (expression.includes('data-testid') && expression.includes('email-field')) {
        return { result: { type: 'object', value: { count: 1, elements: [{ tag: 'input', name: 'Email' }] } } };
      }
      if (expression.includes('querySelectorAll("#save")')) {
        return { result: { type: 'object', value: { count: 1, elements: [{ tag: 'button', name: 'Save' }] } } };
      }
      return { result: { type: 'object', value: { count: 0, elements: [] } } };
    });
    const transport = createControlAdapterAutomationTransport({ adapter: controlAdapter(), contextCapture: surface });

    for (const selector of ['role=button[name="Save"]', 'text=Continue', 'data-testid=email-field', '#save']) {
      const result = await transport.dispatchPageQuery({
        ...view,
        actionKind: 'queryElements',
        navigationGeneration: 1,
        payload: { selector },
      });
      expect(result.ok, selector).toBe(true);
      if (!result.ok) continue;
      expect((result.data as { count?: number }).count, selector).toBe(1);
    }

    const waitResult = await transport.dispatchPageQuery({
      ...view,
      actionKind: 'waitFor',
      navigationGeneration: 1,
      payload: { selector: 'role=button[name="Save"]' },
    });
    expect(waitResult.ok).toBe(true);
    if (!waitResult.ok) return;
    expect(waitResult.data).toMatchObject({ present: true });
  });

  it('executes text locators against aggregate DOM text without targeting structural ancestors', async () => {
    const { documentValue } = createAggregateTextDocument();
    const { surface, calls } = fakeContextCapture((method, params) => {
      if (method !== 'Runtime.evaluate') return {};
      const expression = typeof params?.expression === 'string' ? params.expression : '';
      return cdpEvaluateValue(evaluateBridgeExpression(expression, documentValue));
    });
    const transport = createControlAdapterAutomationTransport({ adapter: controlAdapter(), contextCapture: surface });

    const queryResult = await transport.dispatchPageQuery({
      ...view,
      actionKind: 'queryElements',
      navigationGeneration: 1,
      payload: { selector: 'text=Continue' },
    });
    expect(queryResult.ok).toBe(true);
    if (!queryResult.ok) return;
    expect(queryResult.data).toMatchObject({
      count: 1,
      elements: [{ tag: 'button', name: 'Continue' }],
    });

    const waitResult = await transport.dispatchPageQuery({
      ...view,
      actionKind: 'waitFor',
      navigationGeneration: 1,
      payload: { selector: 'text=Continue' },
    });
    expect(waitResult.ok).toBe(true);
    if (!waitResult.ok) return;
    expect(waitResult.data).toMatchObject({ present: true });

    const clickResult = await transport.dispatchInputCommand?.({
      ...view,
      actionKind: 'click',
      navigationGeneration: 1,
      payload: { selector: 'text=Continue' },
    });
    expect(clickResult?.ok).toBe(true);
    const pressed = calls.find((call) => call.method === 'Input.dispatchMouseEvent' && call.params?.type === 'mousePressed');
    expect(pressed?.params).toMatchObject({ x: 45, y: 20, button: 'left' });
  });

  // MCH-4: mutating input verbs dispatch CDP Input.* over the same transport.
  it('exposes dispatchInputCommand only when a context-capture surface is present', () => {
    expect(createControlAdapterAutomationTransport({ adapter: controlAdapter() }).dispatchInputCommand).toBeUndefined();
    const { surface } = fakeContextCapture(() => ({}));
    expect(
      createControlAdapterAutomationTransport({ adapter: controlAdapter(), contextCapture: surface }).dispatchInputCommand,
    ).toBeTypeOf('function');
  });

  it('dispatches a click to CDP Input.dispatchMouseEvent at the resolved element center', async () => {
    const { surface, calls } = fakeContextCapture((method) => {
      if (method === 'Runtime.evaluate') {
        return { result: { type: 'object', value: { x: 60, y: 40 } } };
      }
      return {};
    });
    const transport = createControlAdapterAutomationTransport({ adapter: controlAdapter(), contextCapture: surface });

    const result = await transport.dispatchInputCommand?.({
      ...view,
      actionKind: 'click',
      navigationGeneration: 1,
      payload: { selector: '#submit' },
    });

    expect(result?.ok).toBe(true);
    const pressed = calls.find((c) => c.method === 'Input.dispatchMouseEvent' && c.params?.type === 'mousePressed');
    expect(pressed?.params).toMatchObject({ x: 60, y: 40, button: 'left' });
  });

  it('resolves semantic and CSS locators before dispatching input commands', async () => {
    const { surface, calls } = fakeContextCapture((method, params) => {
      if (method !== 'Runtime.evaluate') return {};
      const expression = typeof params?.expression === 'string' ? params.expression : '';
      if (expression.includes('querySelector("role=')
        || expression.includes('querySelector("text=')
        || expression.includes('querySelector("data-testid=')) {
        return { result: { type: 'object', value: null } };
      }
      if (
        (expression.includes('getAttribute') && expression.includes('role') && expression.includes('Save'))
        || (expression.includes('textContent') && expression.includes('Continue'))
        || (expression.includes('data-testid') && expression.includes('email-field'))
        || expression.includes('querySelector("#save")')
      ) {
        return { result: { type: 'object', value: { x: 40, y: 24 } } };
      }
      return { result: { type: 'object', value: null } };
    });
    const transport = createControlAdapterAutomationTransport({ adapter: controlAdapter(), contextCapture: surface });

    for (const selector of ['role=button[name="Save"]', 'text=Continue', 'data-testid=email-field', '#save']) {
      const result = await transport.dispatchInputCommand?.({
        ...view,
        actionKind: 'click',
        navigationGeneration: 1,
        payload: { selector },
      });
      expect(result?.ok, selector).toBe(true);
    }

    const pressEvents = calls.filter((call) => call.method === 'Input.dispatchMouseEvent' && call.params?.type === 'mousePressed');
    expect(pressEvents).toHaveLength(4);
    for (const event of pressEvents) {
      expect(event.params).toMatchObject({ x: 40, y: 24, button: 'left' });
    }
  });

  it('inserts text via CDP Input.insertText for a type verb', async () => {
    const { surface, calls } = fakeContextCapture((method) => {
      if (method === 'Runtime.evaluate') {
        return { result: { type: 'object', value: { x: 10, y: 10 } } };
      }
      return {};
    });
    const transport = createControlAdapterAutomationTransport({ adapter: controlAdapter(), contextCapture: surface });

    const result = await transport.dispatchInputCommand?.({
      ...view,
      actionKind: 'type',
      navigationGeneration: 1,
      payload: { selector: '#name', text: 'hello' },
    });

    expect(result?.ok).toBe(true);
    const insert = calls.find((c) => c.method === 'Input.insertText');
    expect(insert?.params).toMatchObject({ text: 'hello' });
  });

  it('reports selector_not_found when a click target cannot be resolved', async () => {
    const { surface } = fakeContextCapture((method) => {
      if (method === 'Runtime.evaluate') return { result: { type: 'object', value: null } };
      return {};
    });
    const transport = createControlAdapterAutomationTransport({ adapter: controlAdapter(), contextCapture: surface });

    const result = await transport.dispatchInputCommand?.({
      ...view,
      actionKind: 'click',
      navigationGeneration: 1,
      payload: { selector: '#missing' },
    });

    expect(result?.ok).toBe(false);
    if (result?.ok) return;
    expect(result?.errorCode).toBe('selector_not_found');
  });
});
