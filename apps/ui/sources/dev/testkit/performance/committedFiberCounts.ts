type CountedFiber = {
    tag: number; flags: number; type: unknown; alternate: CountedFiber | null;
    child: CountedFiber | null; sibling: CountedFiber | null; memoizedProps: Record<string, unknown> | null;
};

function componentName(type: unknown): string {
    if (!type || typeof type === 'string') return 'host';
    const component = type as { displayName?: string; name?: string; render?: unknown; type?: unknown };
    return component.displayName || component.name
        || (component.render ? componentName(component.render) : null)
        || (component.type ? componentName(component.type) : null) || 'Anonymous';
}

function componentIdentity(type: unknown): unknown {
    if (typeof type !== 'object' || type === null) return type;
    const component = type as { $$typeof?: unknown; type?: unknown; render?: unknown };
    if (component.$$typeof === Symbol.for('react.memo')) return componentIdentity(component.type);
    if (component.$$typeof === Symbol.for('react.forward_ref')) return componentIdentity(component.render);
    return type;
}

/**
 * The committed host root of a react-test-renderer tree, read at commit time (a `React.Profiler`'s
 * `onRender`) by `onCommitRoot`. The renderer's private fiber handle is an untyped instrumentation boundary.
 */
export function readTestRendererRoot(instance: unknown): () => CountedFiber {
    let fiber = (instance as { _fiber?: CountedFiber & { return: unknown; stateNode: unknown } })._fiber;
    while (fiber && (fiber as { tag: number }).tag !== 3) fiber = (fiber as { return: typeof fiber }).return;
    if (!fiber) throw new Error('Expected a mounted react-test-renderer root for commit measurement');
    const root = fiber.stateNode as { current: CountedFiber };
    return () => root.current;
}

/** Observe committed React DOM work without replacing any component or subscription owner. */
export function createCommittedFiberRenderCounter() {
    const state = { enabled: false, commits: 0, renders: new Map<string, number>(), componentCommits: new Map<unknown, number>(), renderedMessageIds: new Map<string, number>(), changedProps: new Map<string, number>() };
    const componentTags = new Set([0, 1, 11, 14, 15]);
    const performedWork = 1;
    const isUntouched = (parent: CountedFiber, child: CountedFiber) => {
        for (let previous = parent.child; previous; previous = previous.sibling) if (previous === child) return true;
        return false;
    };
    const api = {
        onCommit(container: Element) {
            if (!state.enabled) return;
            const key = Object.keys(container).find(name => name.startsWith('__reactContainer$'));
            // React DOM's private renderer handle is an untyped instrumentation boundary.
            const root = key ? (container as unknown as Record<string, { stateNode: { current: CountedFiber } }>)[key] : null;
            if (!root) throw new Error('Expected a mounted React DOM root for commit measurement');
            api.onCommitRoot(root.stateNode.current);
        },
        /** The same count from any renderer's committed host root fiber (react-test-renderer: see `readTestRendererRoot`). */
        onCommitRoot(current: CountedFiber) {
            if (!state.enabled) return;
            state.commits += 1;
            const renderedMessageIds = new Set<string>();
            const committedComponents = new Set<unknown>();
            const stack = [current];
            while (stack.length) {
                const fiber = stack.pop()!;
                for (let child = fiber.child; child; child = child.sibling) {
                    if (child.alternate && fiber.alternate && isUntouched(fiber.alternate, child)) continue;
                    if (componentTags.has(child.tag) && child.alternate && (child.flags & performedWork)) {
                        committedComponents.add(componentIdentity(child.type));
                        const name = componentName(child.type);
                        state.renders.set(name, (state.renders.get(name) ?? 0) + 1);
                        const message = child.memoizedProps?.message as { id?: unknown } | undefined;
                        if (name.startsWith('MessageView') && typeof message?.id === 'string') {
                            // The public row and its inner view can both render in one commit.
                            renderedMessageIds.add(message.id);
                        }
                        if (/^(ChatListMessageRow|MessageView|TranscriptRowShell|ChatListContent)/.test(name)) {
                            const before = child.alternate.memoizedProps ?? {};
                            const after = child.memoizedProps ?? {};
                            const changed = Object.keys(after).filter(key => before[key] !== after[key]);
                            const changeKey = `${name}:${changed.length ? changed.join('|') : 'state/context'}`;
                            state.changedProps.set(changeKey, (state.changedProps.get(changeKey) ?? 0) + 1);
                        }
                    }
                    stack.push(child);
                }
            }
            for (const component of committedComponents) state.componentCommits.set(component, (state.componentCommits.get(component) ?? 0) + 1);
            for (const id of renderedMessageIds) state.renderedMessageIds.set(id, (state.renderedMessageIds.get(id) ?? 0) + 1);
        },
        start() { state.enabled = true; state.commits = 0; state.renders.clear(); state.componentCommits.clear(); state.renderedMessageIds.clear(); state.changedProps.clear(); },
        stop() { state.enabled = false; },
        read() {
            const componentCommits = new Map(state.componentCommits);
            return { commits: state.commits, renders: new Map(state.renders),
                commitsFor: (component: unknown) => componentCommits.get(componentIdentity(component)) ?? 0,
                renderedMessageIds: new Map(state.renderedMessageIds), changedProps: new Map(state.changedProps) };
        },
    };
    return api;
}
