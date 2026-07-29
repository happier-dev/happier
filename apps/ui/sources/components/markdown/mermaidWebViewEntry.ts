import mermaid from 'mermaid';
import { removeMermaidNavigation } from './mermaidSanitize';

declare global {
    var HAPPIER_MERMAID: typeof mermaid | undefined;
    var HAPPIER_MERMAID_REMOVE_NAVIGATION: typeof removeMermaidNavigation | undefined;
}

globalThis.HAPPIER_MERMAID = mermaid;
globalThis.HAPPIER_MERMAID_REMOVE_NAVIGATION = removeMermaidNavigation;
