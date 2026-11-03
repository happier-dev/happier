import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod/mini';

import { ComputerCaptureGeometryV1Schema, computerTargetKeyV1 } from '@happier-dev/protocol/computer/v1';
import type { ComputerAccessibilityNodeV1, ComputerTargetV1 } from '@happier-dev/protocol';

import type { ComputerDriverCapture, ManagedComputerDriver } from './managedComputerDriver';
import { ComputerDriverError } from './nativeTransport';

const boundsSchema = z.object({ x: z.number(), y: z.number(), width: z.number().check(z.positive()), height: z.number().check(z.positive()) });
const windowSchema = z.object({ id: z.string().check(z.minLength(1)), pid: z.number().check(z.int(), z.positive()),
  title: z.string(), app_name: z.string(), bounds: z.optional(z.nullable(boundsSchema)) });
const displaysSchema = z.array(z.object({ id: z.string(), bounds: boundsSchema, is_primary: z.boolean(), scale: z.number().check(z.positive()) }));
const nodeSchema = z.object({ ref_id: z.optional(z.string()), role: z.string(), name: z.optional(z.string()), value: z.optional(z.string()),
  bounds: z.optional(boundsSchema), states: z.optional(z.array(z.string())), children: z.optional(z.array(z.unknown())) });
const dispositionSchema = z.object({ delivery: z.enum(['unknown', 'not_delivered', 'delivery_uncertain', 'delivered_unverified', 'delivered_verified']),
  retry: z.enum(['unknown', 'safe', 'unsafe']) });
const envelopeSchema = z.object({ version: z.literal('2.5'), ok: z.boolean(), data: z.optional(z.unknown()),
  error: z.optional(z.object({ code: z.string(), disposition: dispositionSchema })) });
type Envelope = z.infer<typeof envelopeSchema>;

function refusal(result: Envelope): ComputerDriverError {
  const code = result.error?.code;
  return new ComputerDriverError(code === 'STALE_REF' || code === 'AMBIGUOUS_TARGET' ? 'computer_element_stale'
    : code === 'APP_NOT_FOUND' || code === 'WINDOW_NOT_FOUND' ? 'target_not_found'
      : code === 'PERM_DENIED' ? 'input_permission_denied' : code?.toLowerCase() ?? 'driver_result_invalid');
}

/** Pinned v1.0.2 CLI/JSON 2.5 boundary. The CLI owns ref identity and native delivery. */
export async function createAgentDesktopComputerDriver(params: Readonly<{ displayId: string; executablePath: string;
  environment?: Readonly<Record<string, string>> }>): Promise<ManagedComputerDriver> {
  if (!isAbsolute(params.executablePath)) throw new ComputerDriverError('driver_executable_invalid');
  // Ref stores contain accessibility content. Each selected source gets its own private,
  // ephemeral native namespace, rather than sharing the person's ~/.agent-desktop store.
  const stateRoot = await mkdtemp(join(tmpdir(), 'happier-agent-desktop-'));
  const environment: NodeJS.ProcessEnv = { ...process.env, ...params.environment, AGENT_DESKTOP_HOME: stateRoot };
  if (process.platform === 'linux') {
    if (params.displayId.startsWith(':')) { environment.DISPLAY = params.displayId; delete environment.WAYLAND_DISPLAY; }
    else { environment.WAYLAND_DISPLAY = params.displayId; delete environment.DISPLAY; }
  }
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const pending = new Set<Promise<Envelope>>();
  type Binding = Readonly<{ captureId: string; target: ComputerTargetV1; geometry: ComputerDriverCapture['geometry'];
    refs: ReadonlySet<string>; focusedRef?: string }>;
  let binding: Binding | undefined;

  function run(args: readonly string[]): Promise<Envelope> {
    if (closing) return Promise.reject(new ComputerDriverError('driver_unavailable'));
    const operation = new Promise<Envelope>((resolve, reject) => {
      const child = spawn(params.executablePath, [...args], { env: environment, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      const output: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
      child.once('error', () => reject(new ComputerDriverError('driver_unavailable')));
      child.once('close', () => {
        try {
          const parsed = envelopeSchema.safeParse(JSON.parse(Buffer.concat(output).toString('utf8')));
          if (!parsed.success || (!parsed.data.ok && !parsed.data.error)) throw new ComputerDriverError('driver_result_invalid');
          resolve(parsed.data);
        } catch { reject(new ComputerDriverError('driver_result_invalid')); }
      });
    });
    pending.add(operation);
    void operation.then(() => pending.delete(operation), () => pending.delete(operation));
    return operation;
  }
  const read = async (args: readonly string[]) => {
    const result = await run(args);
    if (!result.ok) throw refusal(result);
    return result.data;
  };
  const assertTarget = (target: ComputerTargetV1) => {
    if (closing) throw new ComputerDriverError('driver_unavailable');
    if (target.displayId !== params.displayId) throw new ComputerDriverError('target_mismatch');
    if (target.kind === 'window' && typeof target.windowId !== 'string') throw new ComputerDriverError('target_unsupported');
  };
  const windows = async () => z.array(windowSchema).parse(await read(['list-windows']));
  const targetBounds = async (target: ComputerTargetV1) => {
    assertTarget(target);
    if (target.kind === 'window') {
      const window = (await windows()).find(entry => entry.id === target.windowId && entry.pid === target.pid);
      if (!window) throw new ComputerDriverError('target_not_found');
      if (!window.bounds) throw new ComputerDriverError('capture_unavailable');
      return window.bounds;
    }
    const displays = displaysSchema.parse(await read(['list-displays']));
    // Match the existing logical primary-desktop contract. Other physical displays
    // are not invented as new Happier display connections.
    const primary = displays.find(display => display.is_primary) ?? displays[0];
    if (!primary) throw new ComputerDriverError('capture_unavailable');
    return primary.bounds;
  };
  const screenshot = async (target: ComputerTargetV1, maxImageDimension?: number) => {
    const bounds = await targetBounds(target);
    const image = z.object({ data: z.string(), format: z.literal('png'), width: z.number().check(z.int(), z.positive()),
      height: z.number().check(z.int(), z.positive()), scale_factor: z.number().check(z.positive()) }).parse(
      await read(target.kind === 'window' ? ['screenshot', '--window-id', String(target.windowId)] : ['screenshot', '--screen', '0']));
    let png = Buffer.from(image.data, 'base64');
    if (png.length < 24 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      || png.readUInt32BE(16) !== image.width || png.readUInt32BE(20) !== image.height) throw new ComputerDriverError('driver_result_invalid');
    let width = image.width;
    let height = image.height;
    if (maxImageDimension && Math.max(width, height) > maxImageDimension) {
      const sharp = (await import('sharp')).default;
      const resized = await sharp(png).resize({ width: maxImageDimension, height: maxImageDimension, fit: 'inside', withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true });
      png = resized.data;
      width = resized.info.width;
      height = resized.info.height;
    }
    const geometry = ComputerCaptureGeometryV1Schema.parse({ captureWidth: width, captureHeight: height,
      nativeWidth: bounds.width, nativeHeight: bounds.height, originX: bounds.x, originY: bounds.y,
      scaleX: bounds.width / width, scaleY: bounds.height / height,
      crop: { x: 0, y: 0, width: bounds.width, height: bounds.height } });
    return { png, geometry };
  };
  const snapshot = async (target: ComputerTargetV1) => {
    const data = z.object({ complete: z.boolean(), window: z.object({ id: z.string(), title: z.string() }), tree: z.unknown() }).parse(await read([
      'snapshot', ...(target.kind === 'window' ? ['--window-id', String(target.windowId)] : ['--surface', 'focused']), '--include-bounds',
    ]));
    if (target.kind === 'window' && data.window.id !== target.windowId) throw new ComputerDriverError('target_mismatch');
    const nodes: ComputerAccessibilityNodeV1[] = [];
    let focusedRef: string | undefined;
    const visit = (value: unknown): void => {
      const node = nodeSchema.parse(value);
      if (node.ref_id) {
        nodes.push({ id: node.ref_id, role: node.role, ...(node.name !== undefined ? { name: node.name } : {}),
          ...(node.value !== undefined ? { value: node.value } : {}), ...(node.bounds ? { bounds: node.bounds } : {}) });
        if (node.states?.includes('focused')) focusedRef = node.ref_id;
      }
      for (const child of node.children ?? []) visit(child);
    };
    visit(data.tree);
    return { nodes, complete: data.complete, focusedRef };
  };
  const capture: ManagedComputerDriver['capture'] = async target => {
    assertTarget(target);
    binding = undefined;
    const frame = await screenshot(target);
    // A failed AX observation keeps usable vision with an explicit degraded reason.
    let accessibility: ComputerDriverCapture['accessibility'];
    let focusedRef: string | undefined;
    try {
      const tree = await snapshot(target);
      focusedRef = tree.focusedRef;
      accessibility = { nodes: tree.nodes, complete: tree.complete };
    } catch (error) {
      if (!(error instanceof ComputerDriverError) || error.code === 'driver_unavailable' || error.code === 'driver_result_invalid' || error.code === 'target_mismatch') throw error;
      accessibility = { nodes: [], complete: false, degradedReason: error.code };
    }
    const captureId = randomUUID();
    binding = { captureId, target, geometry: frame.geometry, refs: new Set(accessibility.nodes.map(node => node.id)), ...(focusedRef ? { focusedRef } : {}) };
    return { ...frame, captureId, accessibility };
  };
  const input: ManagedComputerDriver['input'] = async (target, captureId, operation, context) => {
    if (context?.signal?.aborted) return { status: 'interrupted', completion: 'known' };
    const stale = operation.kind === 'element' ? 'computer_element_stale' : 'stale_capture';
    let admitted = false;
    try {
      assertTarget(target);
      if ((operation.kind === 'press' || operation.kind === 'click') && operation.modifiers?.includes('fn')) {
        return { status: 'failed', code: 'input_not_supported' };
      }
      const observed = captureId === null ? undefined : binding;
      const grounded = operation.kind !== 'press' && operation.kind !== 'type';
      if ((captureId !== null || grounded) && (!observed || observed.captureId !== captureId
        || computerTargetKeyV1(observed.target) !== computerTargetKeyV1(target))) return { status: 'failed', code: stale };
      if (operation.kind === 'element' && !observed?.refs.has(operation.elementId)) return { status: 'failed', code: 'computer_element_stale' };
      const point = (x: number, y: number) => {
        if (!observed || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0
          || x >= observed.geometry.captureWidth || y >= observed.geometry.captureHeight) throw new ComputerDriverError('point_outside_capture');
        return { x: observed.geometry.originX + x * observed.geometry.scaleX, y: observed.geometry.originY + y * observed.geometry.scaleY };
      };
      let args: string[];
      switch (operation.kind) {
        case 'move': { const p = point(operation.x, operation.y); args = ['--headed', 'mouse-move', `--xy=${p.x},${p.y}`]; break; }
        case 'element': args = operation.action === 'click' ? ['click', operation.elementId]
          : ['set-value', operation.elementId, '--', operation.value]; break;
        case 'press': args = [...(target.kind === 'display' ? ['--headed'] : []), 'press',
          [...(operation.modifiers ?? []).map(modifier => modifier === 'control' ? 'ctrl' : modifier),
            operation.key.replace(/^Arrow(Left|Right|Up|Down)$/, '$1')].join('+'),
          ...(target.kind === 'window' ? ['--window-id', String(target.windowId)] : [])]; break;
        case 'type': {
          const ref = observed?.focusedRef ?? (await snapshot(target)).focusedRef;
          if (!ref) return { status: 'failed', code: 'computer_element_stale' };
          args = ['type', ref, '--', operation.text]; break;
        }
        case 'click': { const p = point(operation.x, operation.y); args = ['--headed', 'mouse-click', `--xy=${p.x},${p.y}`, '--button', operation.button ?? 'left',
          ...(operation.clickCount ? ['--count', String(operation.clickCount)] : []),
          ...(operation.modifiers ?? []).flatMap(modifier => ['--modifiers', modifier === 'control' ? 'ctrl' : modifier])]; break; }
        case 'drag': { const from = point(operation.fromX, operation.fromY); const to = point(operation.toX, operation.toY);
          args = ['--headed', 'drag', `--from-xy=${from.x},${from.y}`, `--to-xy=${to.x},${to.y}`]; break; }
        case 'wheel': { const p = point(operation.x, operation.y); args = ['--headed', 'mouse-wheel', `--x=${p.x}`, `--y=${p.y}`,
          `--dx=${operation.deltaX}`, `--dy=${operation.deltaY}`]; break; }
      }
      if (operation.kind === 'move' || operation.kind === 'click' || operation.kind === 'drag' || operation.kind === 'wheel') {
        const current = await targetBounds(target);
        const geometry = observed!.geometry;
        if (current.x !== geometry.originX || current.y !== geometry.originY || current.width !== geometry.nativeWidth || current.height !== geometry.nativeHeight)
          return { status: 'failed', code: 'stale_capture' };
      }
      if (context?.signal?.aborted) return { status: 'interrupted', completion: 'known' };
      binding = undefined;
      admitted = true;
      const result = await run(args);
      if (!result.ok) return result.error?.disposition.delivery === 'not_delivered'
        ? { status: 'failed', code: refusal(result).code } : { status: 'interrupted', completion: 'unknown' };
      const data = z.object({ disposition: dispositionSchema }).safeParse(result.data);
      if (!data.success) return { status: 'interrupted', completion: 'unknown' };
      const delivery = data.data.disposition.delivery;
      if (delivery === 'unknown' || delivery === 'delivery_uncertain') return { status: 'interrupted', completion: 'unknown' };
      // Native delivered_verified describes its own readback, not application persistence.
      return { status: 'dispatched' };
    } catch (error) {
      return admitted ? { status: 'interrupted', completion: 'unknown' }
        : { status: 'failed', code: error instanceof ComputerDriverError ? error.code : 'driver_result_invalid' };
    }
  };
  return {
    async listTargets(options) {
      const entries = (await windows()).map(window => ({ target: { kind: 'window' as const, displayId: params.displayId, pid: window.pid, windowId: window.id },
        title: window.title, appName: window.app_name }));
      const displays = displaysSchema.parse(await read(['list-displays']));
      const primary = displays.find(display => display.is_primary) ?? displays[0];
      const targets: Awaited<ReturnType<ManagedComputerDriver['listTargets']>>[number][] = [...entries,
        ...(primary ? [{ target: { kind: 'display' as const, displayId: params.displayId }, title: 'primary', label: 'primary',
          width: primary.bounds.width, height: primary.bounds.height }] : [])];
      if (!options?.includeThumbnails) return targets;
      return await Promise.all(targets.map(async entry => {
        try { const frame = await screenshot(entry.target, 256); return { ...entry, thumbnail: { mimeType: 'image/png' as const,
          base64: frame.png.toString('base64'), width: frame.geometry.captureWidth, height: frame.geometry.captureHeight } }; }
        catch (error) { if (error instanceof ComputerDriverError && error.code !== 'driver_unavailable' && error.code !== 'driver_result_invalid') return entry; throw error; }
      }));
    },
    async checkPermissions() {
      const permission = z.object({ state: z.string() });
      const report = z.object({ accessibility: permission, screen_recording: permission }).parse(await read(['permissions']));
      const grant = (state: string) => state === 'granted' || state === 'not_required' ? 'granted' as const : state === 'denied' ? 'denied' as const : 'unknown' as const;
      return { capture: grant(report.screen_recording.state), input: grant(report.accessibility.state) };
    },
    capture,
    captureFrame: (target, options) => screenshot(target, options?.maxImageDimension),
    input,
    async clipboard(target, operation, context) {
      try {
        assertTarget(target);
        if (context?.signal?.aborted) return { ok: false, code: 'user_canceled' };
        if (operation.kind === 'read') {
          const result = z.object({ type: z.literal('text'), text: z.optional(z.string()), found: z.optional(z.boolean()) })
            .safeParse(await read(['clipboard-get', '--format', 'text']));
          if (!result.success) return { ok: false, code: 'driver_result_invalid' };
          return result.data.text === undefined ? { ok: false, code: 'clipboard_text_unavailable' } : { ok: true, text: result.data.text };
        }
        // Pinned 1.0.2 accepts clipboard text only in argv (including batch JSON).
        // Refuse rather than disclose clipboard content to other local OS users.
        return { ok: false, code: 'input_not_supported' };
      } catch (error) {
        return { ok: false, code: error instanceof ComputerDriverError ? error.code : 'driver_result_invalid' };
      }
    },
    close() {
      return closePromise ??= (async () => { closing = true; await Promise.allSettled([...pending]); binding = undefined; await rm(stateRoot, { recursive: true, force: true }); })();
    },
  };
}
