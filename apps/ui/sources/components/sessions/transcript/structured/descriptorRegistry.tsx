import {
    findStructuredMessageRenderer,
    type StructuredMessageRegistryEntry,
} from './structuredMessageRegistry';

export function findBuiltInStructuredMessageEntry(kind: string): StructuredMessageRegistryEntry<unknown> | null {
    return findStructuredMessageRenderer(kind);
}
