type McpWindowLike = typeof globalThis & {
    __MCP__?: {
        resolveRef?: unknown;
        resolveAll?: unknown;
        countAll?: unknown;
        reverseRefs?: unknown;
    };
};

const REF_PATTERN = /^\[?(?:ref=)?(e\d+)\]?$/;

function xpathForText(text: string): string {
    if (!text.includes('\'')) {
        return `//*[contains(text(), '${text}')]`;
    }

    const parts = text.split('\'');
    const expr = `concat(${parts.map((part, index) => {
        if (index === 0) {
            return `'${part}'`;
        }
        return `,"'",'${part}'`;
    }).join('')})`;
    return `//*[contains(text(), ${expr})]`;
}

export function installTauriMcpWebviewDriverScripts(options?: Readonly<{
    windowObj?: McpWindowLike;
    documentObj?: Document;
}>) {
    const windowObj = options?.windowObj ?? (typeof window !== 'undefined' ? (window as unknown as McpWindowLike) : null);
    const documentObj = options?.documentObj ?? (typeof document !== 'undefined' ? document : null);
    if (!windowObj) {
        return;
    }

    windowObj.__MCP__ = windowObj.__MCP__ ?? {};
    const mcp = windowObj.__MCP__;
    if (!mcp || typeof mcp !== 'object') {
        return;
    }

    if (!documentObj) {
        return;
    }

    if (typeof mcp.resolveRef !== 'function') {
        mcp.resolveRef = ((selectorOrRef: string, strategy?: string) => {
            if (!selectorOrRef) {
                return null;
            }

            const refMatch = selectorOrRef.match(REF_PATTERN);
            if (refMatch) {
                const reverseRefs = mcp.reverseRefs;
                if (!(reverseRefs instanceof Map)) {
                    throw new Error('Ref IDs require a snapshot. Run webview_dom_snapshot first to index elements.');
                }
                return (reverseRefs.get(refMatch[1]) as Element | undefined) ?? null;
            }

            if (strategy === 'text') {
                const xpath = xpathForText(selectorOrRef);
                const result = documentObj.evaluate(xpath, documentObj, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                return result.singleNodeValue as Element | null;
            }

            if (strategy === 'xpath') {
                const result = documentObj.evaluate(selectorOrRef, documentObj, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                return result.singleNodeValue as Element | null;
            }

            return documentObj.querySelector(selectorOrRef);
        }) as unknown;
    }

    if (typeof mcp.resolveAll !== 'function') {
        mcp.resolveAll = ((selector: string, strategy?: string) => {
            if (!selector) {
                return [];
            }

            const refMatch = selector.match(REF_PATTERN);
            if (refMatch) {
                const resolved = (mcp.resolveRef as (selectorOrRef: string, strategy?: string) => Element | null)(selector);
                return resolved ? [resolved] : [];
            }

            if (strategy === 'text') {
                const xpath = xpathForText(selector);
                const snapshot = documentObj.evaluate(xpath, documentObj, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
                const results: Element[] = [];
                for (let index = 0; index < snapshot.snapshotLength; index += 1) {
                    const item = snapshot.snapshotItem(index);
                    if (item) {
                        results.push(item as Element);
                    }
                }
                return results;
            }

            if (strategy === 'xpath') {
                const snapshot = documentObj.evaluate(selector, documentObj, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
                const results: Element[] = [];
                for (let index = 0; index < snapshot.snapshotLength; index += 1) {
                    const item = snapshot.snapshotItem(index);
                    if (item) {
                        results.push(item as Element);
                    }
                }
                return results;
            }

            return Array.from(documentObj.querySelectorAll(selector));
        }) as unknown;
    }

    if (typeof mcp.countAll !== 'function') {
        mcp.countAll = ((selector: string, strategy?: string) => {
            const resolved = mcp.resolveAll as ((selector: string, strategy?: string) => readonly Element[]) | undefined;
            return resolved ? resolved(selector, strategy).length : 0;
        }) as unknown;
    }
}
