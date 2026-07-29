import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import type { Terminal } from '@xterm/xterm';

export function createXtermFitAddon(): FitAddon {
    return new FitAddon();
}

export function loadXtermWebLinksAddon(
    term: Terminal,
    onLink: (url: string) => void,
): void {
    term.loadAddon(new WebLinksAddon((event, uri) => {
        event.preventDefault();
        event.stopPropagation();
        onLink(uri);
    }));
}

export function tryLoadXtermWebglAddon(term: Terminal): boolean {
    try {
        term.loadAddon(new WebglAddon());
        return true;
    } catch {
        return false;
    }
}
