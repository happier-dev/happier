import * as React from 'react';
import { act } from 'react-test-renderer';
import type {
    ReactTestInstance,
    ReactTestRenderer,
    ReactTestRendererJSON,
} from 'react-test-renderer';

import {
    renderWithAppProviders,
    type RenderWithAppProvidersOptions,
} from './renderWithAppProviders';

declare module 'react-test-renderer' {
    interface ReactTestRenderer {
        findByType(type: unknown): ReactTestInstance;
        findAllByType(type: unknown): ReactTestInstance[];
        findByProps(props: Record<string, unknown>): ReactTestInstance;
        findAllByProps(props: Record<string, unknown>): ReactTestInstance[];
        find(predicate: (node: ReactTestInstance) => boolean): ReactTestInstance;
        findAll(predicate: (node: ReactTestInstance) => boolean): ReactTestInstance[];
        findByTestId(testID: string): ReactTestInstance | null;
        findAllByTestId(testID: string): ReactTestInstance[];
        pressByTestId(testID: string): void;
        pressByTestIdAsync(testID: string): Promise<void>;
        changeTextByTestId(testID: string, value: string): void;
    }
}

function findAllByTestId(root: ReactTestInstance, testID: string): ReactTestInstance[] {
    return root.findAll((node) => node.props?.testID === testID);
}

function resolvePreferredTestIdMatch(root: ReactTestInstance, testID: string): ReactTestInstance | null {
    const matches = findAllByTestId(root, testID);
    if (matches.length === 0) {
        return null;
    }

    const actionableMatch = [...matches].reverse().find((node) => (
        typeof node.props?.onPress === 'function' || typeof node.props?.onClick === 'function'
    ));
    if (actionableMatch) {
        return actionableMatch;
    }

    const hostMatch = [...matches].reverse().find((node) => typeof node.type === 'string');
    return hostMatch ?? matches[matches.length - 1] ?? null;
}

function resolveRequiredTestIdTarget(root: ReactTestInstance, testID: string): ReactTestInstance {
    const target = resolvePreferredTestIdMatch(root, testID);
    if (!target) {
        throw new Error(`Unable to find node with testID "${testID}"`);
    }
    return target;
}

function invokePress(target: ReactTestInstance, testID: string): void {
    const handler = target.props?.onPress ?? target.props?.onClick;
    if (typeof handler !== 'function') {
        throw new Error(`Node "${testID}" does not expose onPress/onClick`);
    }
    handler();
}

function resolveRequiredInstance(
    target: ReactTestInstance | null | undefined,
    label: string,
): ReactTestInstance {
    if (!target) {
        throw new Error(`Unable to find ${label}`);
    }
    return target;
}

async function invokePressAsync(target: ReactTestInstance, testID: string): Promise<void> {
    const handler = target.props?.onPress ?? target.props?.onClick;
    if (typeof handler !== 'function') {
        throw new Error(`Node "${testID}" does not expose onPress/onClick`);
    }

    await act(async () => {
        await handler();
    });
}

export function pressTestInstance(target: ReactTestInstance | null | undefined, label = 'test instance'): void {
    invokePress(resolveRequiredInstance(target, label), label);
}

export async function pressTestInstanceAsync(target: ReactTestInstance | null | undefined, label = 'test instance'): Promise<void> {
    await invokePressAsync(resolveRequiredInstance(target, label), label);
}

export function invokeTestInstanceHandler(
    target: ReactTestInstance | null | undefined,
    handlerName: string,
    payload?: unknown,
    label = 'test instance',
): void {
    const handler = resolveRequiredInstance(target, label).props?.[handlerName];
    if (typeof handler !== 'function') {
        throw new Error(`Node "${label}" does not expose ${handlerName}`);
    }
    handler(payload);
}

export function changeTextTestInstance(
    target: ReactTestInstance | null | undefined,
    value: string,
    label = 'test instance',
): void {
    invokeChangeText(resolveRequiredInstance(target, label), label, value);
}

function invokeChangeText(target: ReactTestInstance, testID: string, value: string): void {
    const handler = target.props?.onChangeText;
    if (typeof handler !== 'function') {
        throw new Error(`Node "${testID}" does not expose onChangeText`);
    }
    handler(value);
}

function collectTextContent(value: unknown, parts: string[]): void {
    if (typeof value === 'string' || typeof value === 'number') {
        const text = String(value).trim();
        if (text.length > 0) {
            parts.push(text);
        }
        return;
    }
    if (Array.isArray(value)) {
        for (const entry of value) {
            collectTextContent(entry, parts);
        }
        return;
    }
    if (value && typeof value === 'object') {
        if ('children' in value) {
            const children = (value as { children?: unknown }).children;
            if (Array.isArray(children)) {
                for (const child of children) {
                    collectTextContent(child, parts);
                }
                return;
            }
        }
        if ('props' in value) {
            collectTextContent((value as { props?: { children?: unknown } }).props?.children, parts);
        }
    }
}

function textMatcherIncludes(text: string, matcher: string | readonly string[]): boolean {
    if (typeof matcher !== 'string') {
        return matcher.some((candidate) => text.includes(candidate));
    }
    return text.includes(matcher);
}

export function findTestInstanceByTypeContainingText(
    scope: Pick<ReactTestRenderer | ReactTestInstance, 'findAllByType'>,
    type: unknown,
    matcher: string | readonly string[],
): ReactTestInstance | undefined {
    return scope.findAllByType(type as never).find((node) => {
        const parts: string[] = [];
        collectTextContent(node, parts);
        return textMatcherIncludes(parts.join('\n'), matcher);
    });
}

export function findTestInstanceByTypeWithProps(
    scope: Pick<ReactTestRenderer | ReactTestInstance, 'findAllByType'>,
    type: unknown,
    props: Record<string, unknown>,
): ReactTestInstance | undefined {
    const entries = Object.entries(props);
    return scope.findAllByType(type as never).find((node) => (
        entries.every(([key, value]) => node.props?.[key] === value)
    ));
}

type RenderScreenQueryHelpers = Readonly<{
    root: ReactTestInstance;
    findByType: (type: unknown) => ReactTestInstance;
    findAllByType: (type: unknown) => ReactTestInstance[];
    findByProps: (props: Record<string, unknown>) => ReactTestInstance;
    findAllByProps: (props: Record<string, unknown>) => ReactTestInstance[];
    find: (predicate: (node: ReactTestInstance) => boolean) => ReactTestInstance;
    findByTestId: (testID: string) => ReactTestInstance | null;
    findAllByTestId: (testID: string) => ReactTestInstance[];
    findAll: (predicate: (node: ReactTestInstance) => boolean) => ReactTestInstance[];
    getTextContent: () => string;
    pressByTestId: (testID: string) => void;
    pressByTestIdAsync: (testID: string) => Promise<void>;
    changeTextByTestId: (testID: string, value: string) => void;
}>;

export type RenderScreenTree = ReactTestRenderer;

export type RenderScreenResult = Omit<Awaited<ReturnType<typeof renderWithAppProviders>>, 'tree'> & Readonly<{
    tree: RenderScreenTree;
}> & RenderScreenQueryHelpers;

export type UnexpectedRawTextNode = Readonly<{
    parent: string | null;
    value: string;
}>;

export function collectUnexpectedRawTextNodes(
    node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null,
    allowedParentTypes: readonly string[] = ['Text'],
): UnexpectedRawTextNode[] {
    const allowedParents = new Set(allowedParentTypes);
    const findings: UnexpectedRawTextNode[] = [];

    function walk(value: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null, parentType: string | null): void {
        if (value == null) return;
        if (typeof value === 'string') {
            if (!allowedParents.has(parentType ?? '') && value.trim().length > 0) {
                findings.push({
                    parent: parentType,
                    value,
                });
            }
            return;
        }
        if (Array.isArray(value)) {
            for (const child of value) {
                walk(child, parentType);
            }
            return;
        }

        for (const child of value.children ?? []) {
            walk(child as ReactTestRendererJSON | string | null, value.type);
        }
    }

    walk(node, null);
    return findings;
}

export async function renderScreen(
    element: React.ReactElement,
    options: RenderWithAppProvidersOptions = {},
): Promise<RenderScreenResult> {
    const rendered = await renderWithAppProviders(element, options);

    const getTree = () => rendered.tree as RenderScreenTree;
    const getRoot = () => getTree().root;
    const helpers: RenderScreenQueryHelpers = {
        get root() {
            return getRoot();
        },
        findByType: (type) => getRoot().findByType(type as never),
        findAllByType: (type) => getRoot().findAllByType(type as never),
        findByProps: (props) => getRoot().findByProps(props),
        findAllByProps: (props) => getRoot().findAllByProps(props),
        find: (predicate) => getRoot().find(predicate),
        findByTestId: (testID) => resolvePreferredTestIdMatch(getRoot(), testID),
        findAllByTestId: (testID) => findAllByTestId(getRoot(), testID),
        findAll: (predicate) => getRoot().findAll(predicate),
        getTextContent: () => {
            const parts: string[] = [];
            collectTextContent(getRoot(), parts);
            return parts.join(' ');
        },
        pressByTestId: (testID) => {
            invokePress(resolveRequiredTestIdTarget(getRoot(), testID), testID);
        },
        pressByTestIdAsync: async (testID) => {
            await invokePressAsync(resolveRequiredTestIdTarget(getRoot(), testID), testID);
        },
        changeTextByTestId: (testID, value) => {
            invokeChangeText(resolveRequiredTestIdTarget(getRoot(), testID), testID, value);
        },
    };
    const treeHelpers = {
        findByType: helpers.findByType,
        findAllByType: helpers.findAllByType,
        findByProps: helpers.findByProps,
        findAllByProps: helpers.findAllByProps,
        find: helpers.find,
        findAll: (predicate: (node: ReactTestInstance) => boolean) => getRoot().findAll(predicate),
        findByTestId: helpers.findByTestId,
        findAllByTestId: helpers.findAllByTestId,
        pressByTestId: helpers.pressByTestId,
        pressByTestIdAsync: helpers.pressByTestIdAsync,
        changeTextByTestId: helpers.changeTextByTestId,
    } satisfies Pick<
        ReactTestRenderer,
        | 'findByType'
        | 'findAllByType'
        | 'findByProps'
        | 'findAllByProps'
        | 'find'
        | 'findAll'
        | 'findByTestId'
        | 'findAllByTestId'
        | 'pressByTestId'
        | 'pressByTestIdAsync'
        | 'changeTextByTestId'
    >;
    Object.assign(rendered.tree, treeHelpers);

    const screen = {
        ...rendered,
        tree: getTree(),
        findByType: helpers.findByType,
        findAllByType: helpers.findAllByType,
        findByProps: helpers.findByProps,
        findAllByProps: helpers.findAllByProps,
        find: helpers.find,
        findByTestId: helpers.findByTestId,
        findAllByTestId: helpers.findAllByTestId,
        findAll: helpers.findAll,
        getTextContent: helpers.getTextContent,
        pressByTestId: helpers.pressByTestId,
        pressByTestIdAsync: helpers.pressByTestIdAsync,
        changeTextByTestId: helpers.changeTextByTestId,
    } satisfies Omit<RenderScreenResult, 'root'>;

    Object.defineProperty(screen, 'root', {
        configurable: true,
        enumerable: true,
        get: () => getRoot(),
    });

    return screen as RenderScreenResult;
}
