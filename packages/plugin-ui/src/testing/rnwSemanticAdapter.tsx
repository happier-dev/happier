import { act, cloneElement, Fragment, isValidElement, type ReactElement, type ReactNode } from 'react';

import {
  PluginUiSemanticRoleSchema,
  readPluginUiTestkitTargetedSurfaceAdmission,
} from '@happier-dev/plugin-sdk/testing';
import type {
  PluginUiSemanticAdapterNode,
  PluginUiSemanticRole,
  PluginUiSemanticState,
  PluginUiSemanticSurfaceAdapter,
  PluginUiSemanticSurfaceMount,
  PluginUiSemanticTarget,
} from '@happier-dev/plugin-sdk/testing';
import type { RenderContext, RenderSurface } from '@happier-dev/plugin-sdk/ui';
import type { HappierFocusable } from '../presentation/portableTypes.js';
import type { PluginUiEphemeralSharedScope } from '../hostApi/ephemeralSharedScope.public.js';

import { Text } from '../components/Text.js';
import {
  PluginUiPresentationHostProviderInternal,
  type PluginUiPresentationHost,
  type PluginUiTargetedSurfacePresentation,
} from '../presentationHost/context.js';

/** Optional strict targeted-Surface support for the public RNW semantic adapter. */
export type PluginUiRnwSemanticSurfaceAdapterOptions = Readonly<{
  /** Test-environment physical focus owner used by public logical focus targets. */
  physicalFocus?: (target: HappierFocusable) => boolean;
  /** Optional host-owned scope shared by the artifact mounts under test. */
  ephemeralSharedScope?: PluginUiEphemeralSharedScope;
  targetedSurfaces?: Readonly<{
    /** Read the current strict daemon cold-admission projection on every render. */
    readCurrentMounts(): unknown;
    /** Read the actual public manifest exported by the exact contributor package. */
    readContributorManifest(pluginId: string): unknown;
  }>;
}>;

function createSemanticPresentationHost(input: Readonly<{
  options: PluginUiRnwSemanticSurfaceAdapterOptions;
  readCurrentContext(): RenderContext;
}>): PluginUiPresentationHost {
  return Object.freeze({
    ...(input.options.physicalFocus === undefined
      ? {}
      : { focusTarget: input.options.physicalFocus }),
    renderMarkdown: () => null,
    renderCodeBlock: () => null,
    renderPopover: () => null,
    renderIcon: () => null,
    renderTargetedSurface(presentation: PluginUiTargetedSurfacePresentation) {
      const context = input.readCurrentContext();
      const targetedSurfaces = input.options.targetedSurfaces;
      if (targetedSurfaces === undefined) return presentation.fallback ?? null;
      const admission = readPluginUiTestkitTargetedSurfaceAdmission({
        mounts: targetedSurfaces.readCurrentMounts(),
        target: context.surface.targetedContributions.target,
        surface: presentation.surface,
        launchInput: presentation.input,
        contributorManifest: targetedSurfaces.readContributorManifest(
          presentation.surface.contributor.pluginId,
        ),
        ...(presentation.instanceKey === undefined ? {} : { instanceKey: presentation.instanceKey }),
      });
      if (!admission) return presentation.fallback ?? null;
      return (
        <Fragment key={admission.key}>
          <Text value={admission.content.text} />
        </Fragment>
      );
    },
  });
}

function renderSemanticSurface(input: Readonly<{
  surface: RenderSurface;
  context: RenderContext;
  presentationHost?: PluginUiPresentationHost;
  ephemeralSharedScope?: PluginUiEphemeralSharedScope;
}>): ReactNode {
  const raw = input.surface(input.context) as ReactNode;
  const rawType = isValidElement(raw) ? raw.type : null;
  const rendered = input.ephemeralSharedScope !== undefined
    && isValidElement(raw)
    && (typeof rawType === 'function' || (typeof rawType === 'object' && rawType !== null))
    && Reflect.get(rawType, Symbol.for('happier.pluginUi.privateSurfaceEntryProvider.v1')) === true
      ? cloneElement(
          raw as ReactElement<Record<string, unknown>>,
          { ephemeralSharedScope: input.ephemeralSharedScope },
        )
      : raw;
  return input.presentationHost === undefined
    ? rendered
    : (
        <PluginUiPresentationHostProviderInternal host={input.presentationHost}>
          {rendered}
        </PluginUiPresentationHostProviderInternal>
      );
}

const PRESSABLE_ROLES = new Set<PluginUiSemanticRole>([
  'button',
  'checkbox',
  'link',
  'option',
  'radio',
  'switch',
  'tab',
]);

function normalizeText(value: string | null | undefined): string | undefined {
  const normalized = value?.replace(/\s+/gu, ' ').trim();
  return normalized ? normalized : undefined;
}

function readRole(element: HTMLElement): PluginUiSemanticRole | undefined {
  const rawRole = element.getAttribute('role');
  if (rawRole === 'img') return 'image';
  const parsed = PluginUiSemanticRoleSchema.safeParse(rawRole);
  if (parsed.success) return parsed.data;
  const tagName = element.tagName.toLowerCase();
  if (tagName === 'input' || tagName === 'textarea') return 'textbox';
  if (tagName === 'img') return 'image';
  if (element.hasAttribute('aria-label') && element.querySelector('img') !== null) return 'image';
  return undefined;
}

function readName(element: HTMLElement): string | undefined {
  const labelledBy = element.getAttribute('aria-labelledby');
  const labelledName = labelledBy
    ? labelledBy.split(/\s+/u)
        .map((id) => element.ownerDocument.getElementById(id)?.textContent)
        .map(normalizeText)
        .filter((text): text is string => text !== undefined)
        .join(' ')
    : undefined;
  return normalizeText(labelledName)
    ?? normalizeText(element.getAttribute('aria-label'))
    ?? normalizeText(element.textContent);
}

function readBooleanAria(element: HTMLElement, attribute: string): boolean | undefined {
  const value = element.getAttribute(attribute);
  return value === 'true' ? true : value === 'false' ? false : undefined;
}

function readState(element: HTMLElement): PluginUiSemanticState | undefined {
  const disabled = readBooleanAria(element, 'aria-disabled')
    ?? (element.matches(':disabled') ? true : undefined);
  const busy = readBooleanAria(element, 'aria-busy');
  const selected = readBooleanAria(element, 'aria-selected');
  const checkedValue = element.getAttribute('aria-checked');
  const checked = checkedValue === 'mixed' ? 'mixed' as const : readBooleanAria(element, 'aria-checked');
  const expanded = readBooleanAria(element, 'aria-expanded');
  if ([disabled, busy, selected, checked, expanded].every((value) => value === undefined)) return undefined;
  return Object.freeze({
    ...(disabled === undefined ? {} : { disabled }),
    ...(busy === undefined ? {} : { busy }),
    ...(selected === undefined ? {} : { selected }),
    ...(checked === undefined ? {} : { checked }),
    ...(expanded === undefined ? {} : { expanded }),
  });
}

function readTextFieldFacts(element: HTMLElement): Readonly<{
  label?: string;
  placeholder?: string;
  value?: string;
}> {
  const tagName = element.tagName.toLowerCase();
  if (tagName !== 'input' && tagName !== 'textarea') return {};
  const input = element as HTMLInputElement | HTMLTextAreaElement;
  const label = readName(element);
  const placeholder = normalizeText(input.getAttribute('placeholder'));
  return Object.freeze({
    ...(label === undefined ? {} : { label }),
    ...(placeholder === undefined ? {} : { placeholder }),
    value: input.value,
  });
}

/**
 * Whether the platform has taken this element out of the accessibility tree.
 *
 * A surface that keeps a region MOUNTED but hidden — a retained pane, a stacked
 * composition whose other pane is off screen — is making a real accessibility
 * claim: the reader cannot see it, so a screen reader must not read it and Tab
 * must not enter it. An adapter that reported every element the DOM still holds
 * would answer that claim with the opposite of the truth, and every assertion
 * built on it ("the list is not on screen while the entry is open") would pass
 * for a surface that never hid anything.
 *
 * Hiding is inherited by the subtree and jsdom computes no inherited layout, so
 * the ancestors up to the mount container are walked explicitly. The element's
 * OWN declaration is read rather than a resolved cascade: React Native Web
 * writes the styles this package produces as inline declarations, and asking
 * jsdom to resolve a full cascade for every element of every snapshot costs far
 * more than the class-authored hiding no Happier surface produces.
 *
 * Both platform layout hiding and the explicit accessibility-tree contract hide
 * a node here: `display: none`, `visibility: hidden`, `hidden`, or
 * `aria-hidden="true"` on the node or any ancestor.
 */
function isHiddenFromAccessibilityTree(element: HTMLElement, container: HTMLElement): boolean {
  for (let node: HTMLElement | null = element; node !== null; node = node.parentElement) {
    if (node.hasAttribute('hidden')) return true;
    if (node.getAttribute('aria-hidden') === 'true') return true;
    if (node.style.display === 'none' || node.style.visibility === 'hidden') return true;
    if (node === container) break;
  }
  return false;
}

function readSemanticNode(
  element: HTMLElement,
  handle: string,
): PluginUiSemanticAdapterNode | undefined {
  const role = readRole(element);
  if (!role) return undefined;
  const state = readState(element);
  const name = readName(element);
  const textField = readTextFieldFacts(element);
  return Object.freeze({
    handle,
    role,
    ...(name === undefined ? {} : { name }),
    ...(state === undefined ? {} : { state }),
    ...(textField.label === undefined ? {} : { label: textField.label }),
    ...(textField.placeholder === undefined ? {} : { placeholder: textField.placeholder }),
    ...(textField.value === undefined ? {} : { value: textField.value }),
    ...(PRESSABLE_ROLES.has(role) && state?.disabled !== true ? { actions: ['press'] as const } : {}),
  });
}

function semanticTargetMatches(
  node: PluginUiSemanticAdapterNode,
  target: PluginUiSemanticTarget,
): boolean {
  return node.role === target.role
    && node.name === target.name
    && node.state?.disabled === target.state?.disabled
    && node.state?.busy === target.state?.busy
    && node.state?.selected === target.state?.selected
    && node.state?.checked === target.state?.checked
    && node.state?.expanded === target.state?.expanded
    && node.label === target.label
    && node.placeholder === target.placeholder
    && node.value === target.value;
}

function readTextNodes(container: HTMLElement): readonly Readonly<{ content: string }>[] {
  const texts: Readonly<{ content: string }>[] = [];
  // DOM TreeWalker `SHOW_TEXT`; keep traversal owned by the mounted document rather
  // than depending on an ambient DOM global in an external author runner.
  const textNodeFilter = 4;
  const walker = container.ownerDocument.createTreeWalker(container, textNodeFilter);
  for (let current = walker.nextNode(); current !== null; current = walker.nextNode()) {
    const content = normalizeText(current.textContent);
    if (content === undefined) continue;
    // Text the platform has hidden is not text the reader can reach, for the
    // same reason its enclosing element is not a semantic node.
    const owner = current.parentElement;
    if (owner !== null && isHiddenFromAccessibilityTree(owner, container)) continue;
    texts.push(Object.freeze({ content }));
  }
  return Object.freeze(texts);
}

type SemanticRnwMount = Readonly<{
  container: HTMLElement;
  render(element: ReactNode): Promise<void>;
  unmount(): void;
}>;

type SemanticReactRoot = Readonly<{
  render(element: ReactNode): void;
  unmount(): void;
}>;

async function mountRnw(element: ReactNode): Promise<SemanticRnwMount> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: SemanticReactRoot | undefined;
  try {
    const reactDomClientModule = 'react-dom/client';
    const { createRoot } = await import(reactDomClientModule) as Readonly<{
      createRoot(container: Element): SemanticReactRoot;
    }>;
    await act(async () => {
      root = createRoot(container);
      root.render(element);
    });
    if (!root) throw new Error('The Plugin UI semantic surface did not mount.');
  } catch (error) {
    const partiallyMountedRoot = root;
    try {
      if (partiallyMountedRoot) act(() => { partiallyMountedRoot.unmount(); });
    } finally {
      container.remove();
    }
    throw error;
  }
  const mountedRoot = root;
  if (!mountedRoot) throw new Error('The Plugin UI semantic surface did not mount.');
  let unmounted = false;
  return {
    container,
    async render(next) {
      if (unmounted) throw new Error('The Plugin UI semantic surface is no longer current.');
      await act(async () => { mountedRoot.render(next); });
    },
    unmount() {
      if (unmounted) return;
      unmounted = true;
      try {
        act(() => { mountedRoot.unmount(); });
      } finally {
        container.remove();
      }
    },
  };
}

/**
 * RNW adapter behind the public semantic testing entry.
 *
 * Only bounded roles, names, states and supported actions cross into the SDK
 * testkit. DOM nodes, React roots and private presentation hosts never do.
 */
export function createPluginUiRnwSemanticSurfaceAdapter(
  options: PluginUiRnwSemanticSurfaceAdapterOptions = {},
): PluginUiSemanticSurfaceAdapter<RenderSurface> {
  return {
    async mount({ surface, context, signal }) {
      if (signal.aborted) throw new Error('The Plugin UI semantic surface was already cancelled.');
      let currentContext = context;
      const presentationHost = options.targetedSurfaces === undefined && options.physicalFocus === undefined
        ? undefined
        : createSemanticPresentationHost({
            options,
            readCurrentContext: () => currentContext,
          });
      const mount = await mountRnw(renderSemanticSurface({
        surface,
        context,
        presentationHost,
        ...(options.ephemeralSharedScope === undefined
          ? {}
          : { ephemeralSharedScope: options.ephemeralSharedScope }),
      }));
      let revision = 0;
      let disposed = false;
      let disposal: Promise<void> | undefined;
      const elementsByHandle = new Map<string, HTMLElement>();
      const handlesByElement = new WeakMap<HTMLElement, string>();
      let nextHandle = 0;
      const handleForElement = (element: HTMLElement): string => {
        const existing = handlesByElement.get(element);
        if (existing !== undefined) return existing;
        const handle = `element-${nextHandle}`;
        nextHandle += 1;
        handlesByElement.set(element, handle);
        return handle;
      };
      const assertActive = () => {
        if (disposed || signal.aborted) throw new Error('The Plugin UI semantic surface is no longer current.');
      };
      const dispose = (): Promise<void> => {
        if (disposal) return disposal;
        disposed = true;
        disposal = Promise.resolve().then(() => {
          signal.removeEventListener('abort', onAbort);
          elementsByHandle.clear();
          mount.unmount();
        });
        return disposal;
      };
      const onAbort = () => { void dispose(); };
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) {
        await dispose();
        throw new Error('The Plugin UI semantic surface was cancelled while mounting.');
      }

      const semanticMount: PluginUiSemanticSurfaceMount = {
        async snapshot() {
          assertActive();
          elementsByHandle.clear();
          const nodes: PluginUiSemanticAdapterNode[] = [];
          for (const element of mount.container.querySelectorAll<HTMLElement>('[role], input, textarea, img, [aria-label]')) {
            if (isHiddenFromAccessibilityTree(element, mount.container)) continue;
            const handle = handleForElement(element);
            const node = readSemanticNode(element, handle);
            if (!node) continue;
            elementsByHandle.set(handle, element);
            nodes.push(node);
          }
          return Object.freeze({
            revision,
            nodes: Object.freeze(nodes),
            texts: readTextNodes(mount.container),
          });
        },
        async update(nextContext: RenderContext) {
          assertActive();
          const previousContext = currentContext;
          currentContext = nextContext;
          try {
            await mount.render(renderSemanticSurface({
              surface,
              context: nextContext,
              presentationHost,
              ...(options.ephemeralSharedScope === undefined
                ? {}
                : { ephemeralSharedScope: options.ephemeralSharedScope }),
            }));
          } catch (error) {
            currentContext = previousContext;
            throw error;
          }
          assertActive();
          revision += 1;
          elementsByHandle.clear();
        },
        async invoke({ revision: requestedRevision, handle, action, target }) {
          assertActive();
          if (requestedRevision !== revision || action !== 'press') {
            throw new Error('The Plugin UI semantic target is stale.');
          }
          const element = elementsByHandle.get(handle);
          const node = element ? readSemanticNode(element, handle) : undefined;
          if (
            !element
            || !element.isConnected
            || !mount.container.contains(element)
            || !node
            || !node.actions?.includes('press')
            || !semanticTargetMatches(node, target)
          ) {
            throw new Error('The Plugin UI semantic target is no longer pressable.');
          }
          await act(async () => { element.click(); });
        },
        dispose,
      };
      return semanticMount;
    },
  };
}
