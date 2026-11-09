import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';

import type { EmbeddedTerminalRendererResource } from '../embedded/embeddedTerminalRendererHandle';
import type { createXtermFindEngine } from './findEngine';
import type { XtermTerminalHandle, XtermTerminalViewProps } from './XtermTerminalView.web';

/** Cache retention and an attached host share the existing renderer, never its input reader. */
export class XtermRetainedResource implements EmbeddedTerminalRendererResource {
    readonly kind = 'xterm-web';
    retained = false;
    private mounted = true;
    private destroyed = false;

    constructor(readonly runtime: Readonly<{
        container: HTMLDivElement;
        terminal: Terminal;
        fitAddon: FitAddon;
        find: ReturnType<typeof createXtermFindEngine>;
        handle: XtermTerminalHandle;
        bind: (props: XtermTerminalViewProps) => void;
        attach: (host: HTMLDivElement) => void;
        detach: () => void;
        destroy: () => void;
        whenSettled: () => Promise<void>;
    }>) {}

    capture(): EmbeddedTerminalRendererResource {
        this.retained = true;
        return this;
    }

    get attached(): boolean {
        return this.mounted;
    }

    bind(props: XtermTerminalViewProps): void {
        this.runtime.bind(props);
    }

    canAttach(): boolean {
        return !this.destroyed && !this.mounted;
    }

    attach(host: HTMLDivElement, props: XtermTerminalViewProps): boolean {
        if (!this.canAttach()) return false;
        this.mounted = true;
        // xterm.open() returns immediately once opened; move its original parent instead.
        this.runtime.container.removeAttribute('data-testid');
        host.replaceChildren(this.runtime.container);
        this.bind(props);
        this.runtime.attach(host);
        return true;
    }

    detach(): void {
        if (!this.mounted) return;
        this.mounted = false;
        this.runtime.detach();
        if (!this.retained) this.destroy();
    }

    whenSettled(): Promise<void> {
        return this.runtime.whenSettled();
    }

    dispose(): void {
        this.retained = false;
        // LRU eviction releases the cache's hold, not a currently attached host's renderer.
        if (!this.mounted) this.destroy();
    }

    private destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        this.runtime.destroy();
    }
}
