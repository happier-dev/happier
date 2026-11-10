import type * as React from 'react';
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
    parentTargetInput?: PluginUiJsonValueV1 | null;
}>;
/** The carried card's identity: a title, one quiet state line, and the item's own mark (lab C2). */
export type EntityDragSourceDescription = Readonly<{
    title: string; subtitle?: string; renderMark?: (size: number) => React.ReactNode;
    /** A mounted source that announces its own moves also owns acknowledgement clearing. */
    announcementOwner?: 'source';
}>;
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
/** Host collections may resolve each place in the admitted source scope; real targets stay exact. */
type EntityDropTargetScope =
    | Readonly<{ scope: EntityDragScopeV1; scopeMode?: 'target' }>
    | Readonly<{ scopeMode: 'source'; scope?: never }>;
export type EntityDropTarget = EntityDropTargetScope & Readonly<{
    id: string;
    acceptedKinds: readonly EntityDragKindV1[];
    /** Owns these accepted kinds throughout its measured region, including over child targets. */
    captureKinds?: readonly EntityDragKindV1[];
    parentId?: string;
    /** Presentation data retained once by this mounted target for its immediate children. */
    input?: PluginUiJsonValueV1;
    getBounds: () => WindowBounds | null;
    /** A region the carried card keeps clear of while this target is selected (the composer's block). */
    getClearBounds?: () => WindowBounds | null;
    /** Native/hosted measurement at pointer release, before final hit testing and dispatch. */
    measureBounds?: (pointer: WindowPointer | null) => Promise<void>;
    /** Shape strategies may reject points within an enclosing rectangle. */
    containsPointer?: (pointer: WindowPointer) => boolean;
    isCurrent?: () => boolean;
    /** Current domain destinations, including virtualized/unmounted rows. Admission stays in resolve. */
    listDestinations?: (item: EntityDragItemV1) => readonly EntityDropSemanticDestination[];
    resolve: (context: EntityDropResolveContext) => EntityDropAdmissionV1;
    /** Local identity of an admitted discrete place. Null keeps continuous movement quiet inside this target. */
    getDestinationKey?: (context: EntityDropResolveContext, admission: Extract<EntityDropAdmissionV1, { status: 'allowed' }>) => string | null;
    execute: (effect: EntityDropEffectV1, context: EntityDropResolveContext) => Promise<EntityDropOutcomeV1>;
    /** Supplied by the existing scroll owner, with its own metrics and speed policy. */
    autoscroll?: (pointer: WindowPointer) => void;
}>;
export type EntityDragDropSnapshot = Readonly<{
    phase: 'idle' | 'carrying' | 'pending' | 'settled';
    item: EntityDragItemV1 | null;
    sourceId: string | null;
    targetId: string | null;
    /** Resolver-owned place, independent of pointer frames, translated previews and revision checks. */
    destinationKey: string | null;
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
    /** The region a registered target asked the carried card to keep clear of, when it did. */
    getTargetClearBounds: (targetId: string) => WindowBounds | null;
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
