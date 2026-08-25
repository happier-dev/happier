export type WebTranscriptKeyboardVerticalDirection = 'toward-start' | 'toward-end';

export type WebTranscriptKeyboardOwnerRegistration = Readonly<{
    document: Document;
    onViewportKeyboardInput: (verticalDirection: WebTranscriptKeyboardVerticalDirection) => void;
    resolveScroller: () => HTMLElement | null;
}>;

type RegisteredEntry = Readonly<{
    id: symbol;
    onViewportKeyboardInput: WebTranscriptKeyboardOwnerRegistration['onViewportKeyboardInput'];
    resolveScroller: WebTranscriptKeyboardOwnerRegistration['resolveScroller'];
}> & {
    ownedTabIndexElement: HTMLElement | null;
};

type DocumentRegistry = Readonly<{
    document: Document;
    entries: Map<symbol, RegisteredEntry>;
    onFocusIn: (event: Event) => void;
    onKeyDown: (event: KeyboardEvent) => void;
    onPointerDown: (event: Event) => void;
}> & {
    lastExplicitlyInteractedEntry: RegisteredEntry | null;
};

const documentRegistries = new WeakMap<Document, DocumentRegistry>();

const TRANSCRIPT_VIEWPORT_KEYBOARD_INPUT_KEYS = new Set([
    'PageUp',
    'PageDown',
    'ArrowUp',
    'ArrowDown',
    'Home',
    'End',
    ' ',
    'Spacebar',
]);

function resolveKeyboardVerticalDirection(
    event: KeyboardEvent,
): WebTranscriptKeyboardVerticalDirection {
    if (
        event.key === 'PageUp'
        || event.key === 'ArrowUp'
        || event.key === 'Home'
        || ((event.key === ' ' || event.key === 'Spacebar') && event.shiftKey)
    ) {
        return 'toward-start';
    }
    return 'toward-end';
}

const TRANSCRIPT_VIEWPORT_KEYBOARD_EXCLUSION_SELECTOR = [
    'input',
    'textarea',
    'select',
    '[contenteditable]:not([contenteditable="false"])',
    '[role="textbox"]',
    'dialog',
    '[role="dialog"]',
    '[role="menu"]',
    '[role="listbox"]',
    '[role="combobox"]',
].join(', ');

function isExcludedKeyboardTarget(target: unknown): boolean {
    const candidate = target as Readonly<{
        isContentEditable?: unknown;
        tagName?: unknown;
        closest?: (selector: string) => unknown;
    }> | null | undefined;
    if (!candidate) return false;
    if (candidate.isContentEditable === true) return true;
    const tagName = typeof candidate.tagName === 'string' ? candidate.tagName.toLowerCase() : '';
    if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') return true;
    return typeof candidate.closest === 'function'
        && candidate.closest(TRANSCRIPT_VIEWPORT_KEYBOARD_EXCLUSION_SELECTOR) !== null;
}

function isNode(target: EventTarget | null): target is Node {
    return target !== null && typeof (target as Node).nodeType === 'number';
}

function resolveContainingEntry(
    registry: DocumentRegistry,
    target: EventTarget | null,
): RegisteredEntry | null {
    if (!isNode(target)) return null;
    let current: Node | null = target;
    while (current) {
        const matches: RegisteredEntry[] = [];
        for (const entry of registry.entries.values()) {
            if (entry.resolveScroller() === current) {
                matches.push(entry);
            }
        }
        if (matches.length === 1) return matches[0] ?? null;
        if (matches.length > 1) return null;
        current = current.parentNode;
    }
    return null;
}

function resolveSoleConnectedEntry(registry: DocumentRegistry): RegisteredEntry | null {
    let soleEntry: RegisteredEntry | null = null;
    for (const entry of registry.entries.values()) {
        if (!entry.resolveScroller()?.isConnected) continue;
        if (soleEntry) return null;
        soleEntry = entry;
    }
    return soleEntry;
}

function releaseOwnedTabIndex(entry: RegisteredEntry): void {
    const element = entry.ownedTabIndexElement;
    entry.ownedTabIndexElement = null;
    if (element?.getAttribute('tabindex') === '-1') {
        element.removeAttribute('tabindex');
    }
}

function focusScroller(entry: RegisteredEntry, scroller: HTMLElement): void {
    if (
        entry.ownedTabIndexElement &&
        (
            entry.ownedTabIndexElement !== scroller ||
            entry.ownedTabIndexElement.getAttribute('tabindex') !== '-1'
        )
    ) {
        releaseOwnedTabIndex(entry);
    }
    if (!scroller.hasAttribute('tabindex')) {
        scroller.setAttribute('tabindex', '-1');
        entry.ownedTabIndexElement = scroller;
    }
    scroller.focus({ preventScroll: true });
}

/**
 * Return focus to the one already-registered transcript viewport. This deliberately consumes the
 * keyboard owner's existing per-document entry and tabindex lifecycle instead of introducing a
 * second global focus registry for transient transcript rows.
 */
export function focusRegisteredWebTranscriptKeyboardViewport(params: Readonly<{
    document: Document;
    scroller: HTMLElement;
}>): boolean {
    if (!params.scroller.isConnected) return false;
    const registry = documentRegistries.get(params.document);
    if (!registry) return false;
    const matches = Array.from(registry.entries.values()).filter((entry) => (
        entry.resolveScroller() === params.scroller
    ));
    if (matches.length !== 1) return false;
    const entry = matches[0];
    if (!entry) return false;
    focusScroller(entry, params.scroller);
    return true;
}

function isDocumentFallbackTarget(document: Document, target: EventTarget | null): boolean {
    return target === document || target === document.body || target === document.documentElement;
}

function createDocumentRegistry(document: Document): DocumentRegistry {
    const registry: DocumentRegistry = {
        document,
        entries: new Map(),
        lastExplicitlyInteractedEntry: null,
        onFocusIn(event) {
            registry.lastExplicitlyInteractedEntry = resolveContainingEntry(registry, event.target);
        },
        onPointerDown(event) {
            registry.lastExplicitlyInteractedEntry = resolveContainingEntry(registry, event.target);
        },
        onKeyDown(event) {
            if (
                !TRANSCRIPT_VIEWPORT_KEYBOARD_INPUT_KEYS.has(event.key) ||
                isExcludedKeyboardTarget(event.target) ||
                isExcludedKeyboardTarget(document.activeElement)
            ) {
                return;
            }
            const directEntry = resolveContainingEntry(registry, event.target);
            const usesDocumentFallback =
                directEntry === null &&
                isDocumentFallbackTarget(document, event.target);
            const entry = directEntry ?? (
                usesDocumentFallback
                    ? registry.lastExplicitlyInteractedEntry ?? resolveSoleConnectedEntry(registry)
                    : null
            );
            if (!entry || !registry.entries.has(entry.id)) return;
            const scroller = entry.resolveScroller();
            if (!scroller?.isConnected) {
                if (registry.lastExplicitlyInteractedEntry === entry) {
                    registry.lastExplicitlyInteractedEntry = null;
                }
                releaseOwnedTabIndex(entry);
                return;
            }
            entry.onViewportKeyboardInput(resolveKeyboardVerticalDirection(event));
            if (usesDocumentFallback) {
                focusScroller(entry, scroller);
            }
        },
    };
    document.addEventListener('keydown', registry.onKeyDown, true);
    document.addEventListener('focusin', registry.onFocusIn);
    document.addEventListener('pointerdown', registry.onPointerDown);
    return registry;
}

export function registerWebTranscriptKeyboardOwner(
    registration: WebTranscriptKeyboardOwnerRegistration,
): () => void {
    let registry = documentRegistries.get(registration.document);
    if (!registry) {
        registry = createDocumentRegistry(registration.document);
        documentRegistries.set(registration.document, registry);
    }
    const entry: RegisteredEntry = {
        id: Symbol('web-transcript-keyboard-owner'),
        onViewportKeyboardInput: registration.onViewportKeyboardInput,
        ownedTabIndexElement: null,
        resolveScroller: registration.resolveScroller,
    };
    registry.entries.set(entry.id, entry);

    return () => {
        if (!registry?.entries.delete(entry.id)) return;
        if (registry.lastExplicitlyInteractedEntry === entry) {
            registry.lastExplicitlyInteractedEntry = null;
        }
        releaseOwnedTabIndex(entry);
        if (registry.entries.size > 0) return;
        registration.document.removeEventListener('keydown', registry.onKeyDown, true);
        registration.document.removeEventListener('focusin', registry.onFocusIn);
        registration.document.removeEventListener('pointerdown', registry.onPointerDown);
        documentRegistries.delete(registration.document);
    };
}
