import type {
    EntityDragItemV1, EntityDragKindV1, EntityDragScopeV1, EntityDropAdmissionV1,
    EntityDropEffectV1, EntityDropOutcomeV1, PluginUiJsonValueV1,
} from '@happier-dev/protocol/plugins/ui';
import type { WindowBounds, WindowPointer } from './treeDragDropTypes';

export type EntityDragInput = 'pointer' | 'keyboard' | 'chooser' | 'action';
export type EntityDropResolveContext = Readonly<{
    item: EntityDragItemV1;
    pointer: WindowPointer | null;
    destination: PluginUiJsonValueV1 | null;
    input: EntityDragInput;
}>;
export type EntityDragSourceDescription = Readonly<{ title: string; subtitle?: string }>;
export type EntityDragSource = Readonly<{
    id: string;
    scope: EntityDragScopeV1;
    getItem: () => EntityDragItemV1 | null;
    isCurrent: () => boolean;
    /** Localized identity read by the realm overlay, never serialized with the item. */
    describe?: () => EntityDragSourceDescription | null;
    /** Existing source geometry in window coordinates, for refused pointer-release feedback. */
    getBounds?: () => WindowBounds | null;
}>;
export type EntityDropSemanticDestination = Readonly<{
    destination: PluginUiJsonValueV1;
    label: string;
    group?: string;
}>;
export type EntityDropTarget = Readonly<{
    id: string;
    scope: EntityDragScopeV1;
    acceptedKinds: readonly EntityDragKindV1[];
    /** Owns these accepted kinds throughout its measured region, including over child targets. */
    captureKinds?: readonly EntityDragKindV1[];
    parentId?: string;
    getBounds: () => WindowBounds | null;
    /** Native/hosted measurement at pointer release, before final hit testing and dispatch. */
    measureBounds?: () => Promise<void>;
    /** Shape strategies may reject points within an enclosing rectangle. */
    containsPointer?: (pointer: WindowPointer) => boolean;
    isCurrent?: () => boolean;
    /** Current domain destinations, including virtualized/unmounted rows. Admission stays in resolve. */
    listDestinations?: (item: EntityDragItemV1) => readonly EntityDropSemanticDestination[];
    resolve: (context: EntityDropResolveContext) => EntityDropAdmissionV1;
    execute: (effect: EntityDropEffectV1) => Promise<EntityDropOutcomeV1>;
    /** Supplied by the existing scroll owner, with its own metrics and speed policy. */
    autoscroll?: (pointer: WindowPointer) => void;
}>;
export type EntityDragDropSnapshot = Readonly<{
    phase: 'idle' | 'carrying' | 'pending' | 'settled';
    item: EntityDragItemV1 | null;
    sourceId: string | null;
    targetId: string | null;
    admission: EntityDropAdmissionV1 | null;
    outcome: EntityDropOutcomeV1 | null;
}>;
export type EntityDropDestination = Readonly<{
    targetId: string;
    destination?: PluginUiJsonValueV1;
    label?: string;
    group?: string;
    admission: EntityDropAdmissionV1;
}>;
export type EntityDragCarry = Readonly<{
    move: (pointer: WindowPointer | null) => void;
    choose: (targetId: string, destination?: PluginUiJsonValueV1) => void;
    release: () => Promise<EntityDropOutcomeV1 | null>;
    cancel: (reason?: string) => void;
}>;
export type EntityDragDropRuntime = Readonly<{
    registerSource: (source: EntityDragSource) => () => void;
    describeSource: (sourceId: string) => EntityDragSourceDescription | null;
    getSourceBounds: (sourceId: string) => WindowBounds | null;
    registerTarget: (target: EntityDropTarget) => () => void;
    begin: (sourceId: string, input?: 'pointer' | 'keyboard') => EntityDragCarry | null;
    move: (pointer: WindowPointer | null) => void;
    choose: (targetId: string, destination?: PluginUiJsonValueV1) => void;
    release: () => Promise<EntityDropOutcomeV1 | null>;
    cancel: (reason?: string) => void;
    refresh: () => void;
    /** Scroll/layout owners refresh native target coordinates for the current pointer carry. */
    refreshMeasurements: () => Promise<void>;
    autoscroll: () => void;
    getDestinations: (sourceId: string) => readonly EntityDropDestination[];
    perform: (sourceId: string, targetId: string, destination?: PluginUiJsonValueV1, input?: 'chooser' | 'action') => Promise<EntityDropOutcomeV1 | null>;
    getSnapshot: () => EntityDragDropSnapshot;
    subscribe: (listener: () => void) => () => void;
    getPointer: () => WindowPointer | null;
    subscribePointer: (listener: () => void) => () => void;
}>;
