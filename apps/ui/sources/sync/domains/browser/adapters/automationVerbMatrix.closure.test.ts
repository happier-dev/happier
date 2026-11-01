import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
    BrowserAutomationActionKindV1Schema,
    BrowserAutomationAdapterCapabilityKindV1Schema,
    type BrowserAdapterCapabilitiesV1,
    type BrowserAutomationActionCapabilityMapV1,
    type BrowserAutomationAdapterCapabilityKindV1,
    type BrowserRenderEngineKindV1,
    type BrowserSemanticAdapterKindV1,
    type BrowserViewTargetKindV1,
} from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { buildBrowserAdapterCapabilities } from './capabilities';
import type { DesktopWebViewSupport } from './desktopWebView';
import { INJECTED_PAGE_AUTOMATION_ACTIONS } from '@happier-dev/peer-mediation/browser/collector/actions';

/**
 * UB-1. The automation protocol advertises far more than any surface actually performs,
 * and until this test existed the real matrix was undocumented — an agent had to dispatch a verb
 * to discover it was dead. `docs/browser-automation-verb-matrix.md` is the published answer, and
 * this test RENDERS that table from {@link buildBrowserAdapterCapabilities} and compares it to the
 * committed bytes. There is no hand-maintained second table: change the capability builder and
 * this test fails until the doc is regenerated from it.
 */

const DOC_PATH = join(__dirname, '../../../../../../../docs/browser-automation-verb-matrix.md');
const TABLE_START = '<!-- BEGIN GENERATED: automation-verb-matrix -->';
const TABLE_END = '<!-- END GENERATED: automation-verb-matrix -->';

const FULL_DESKTOP_SUPPORT: DesktopWebViewSupport = {
    navigation: true,
    goBackForward: true,
    reload: true,
    stop: true,
    pageInfoDiagnostics: true,
    nativeDevtools: true,
    capture: true,
    recording: false,
    automation: true,
};

type Surface = Readonly<{
    label: string;
    adapterKind: BrowserSemanticAdapterKindV1;
    supportedTargetKinds: readonly BrowserViewTargetKindV1[];
    supportedRenderEngines: readonly BrowserRenderEngineKindV1[];
    desktopWebViewSupport?: DesktopWebViewSupport | null;
    nativeViewCaptureHandlerRegistered?: boolean;
}>;

/** Engine capability scenarios, including factual prerequisites and unavailable target kinds. */
const SURFACES: readonly Surface[] = [
    {
        label: 'External URL · web (`webIframe`)',
        adapterKind: 'externalUrl',
        supportedTargetKinds: ['externalUrl'],
        supportedRenderEngines: ['webIframe'],
    },
    {
        label: 'External URL · iOS/Android (`nativeWebView`)',
        adapterKind: 'externalUrl',
        supportedTargetKinds: ['externalUrl'],
        supportedRenderEngines: ['nativeWebView'],
    },
    {
        label: 'External URL · desktop (`desktopWebView`)',
        adapterKind: 'externalUrl',
        supportedTargetKinds: ['externalUrl'],
        supportedRenderEngines: ['desktopWebView'],
        desktopWebViewSupport: FULL_DESKTOP_SUPPORT,
    },
    {
        label: 'External URL · desktop with reverse-capture handler',
        adapterKind: 'externalUrl',
        supportedTargetKinds: ['externalUrl'],
        supportedRenderEngines: ['desktopWebView'],
        desktopWebViewSupport: FULL_DESKTOP_SUPPORT,
        nativeViewCaptureHandlerRegistered: true,
    },
    {
        label: 'Local service preview · web (`webIframe`)',
        adapterKind: 'localPreview',
        supportedTargetKinds: ['localServicePreview'],
        supportedRenderEngines: ['webIframe'],
    },
    {
        label: 'Local service preview · native (`nativeWebView`)',
        adapterKind: 'localPreview',
        supportedTargetKinds: ['localServicePreview'],
        supportedRenderEngines: ['nativeWebView'],
    },
    {
        label: 'Hosted plugin web view',
        adapterKind: 'hostedPlugin',
        supportedTargetKinds: ['hostedPluginWeb'],
        supportedRenderEngines: ['webIframe'],
    },
    {
        label: 'Simulator preview',
        adapterKind: 'simulatorPreview',
        supportedTargetKinds: ['simulatorPreview'],
        supportedRenderEngines: ['streamedSurface'],
    },
    {
        // Display/navigation are live; daemon automation is not a local render-engine producer.
        label: 'Streamed browser surface (daemon-owned automation)',
        adapterKind: 'streamedBrowserSurface',
        supportedTargetKinds: ['streamedBrowser'],
        supportedRenderEngines: ['streamedSurface'],
    },
    {
        label: 'Chromium sidecar stream (daemon-owned automation)',
        adapterKind: 'chromiumSidecar',
        supportedTargetKinds: ['externalUrl'],
        supportedRenderEngines: ['streamedSurface'],
    },
];

const CAPABILITY_KINDS = BrowserAutomationAdapterCapabilityKindV1Schema.options;

function capabilitiesFor(surface: Surface): BrowserAdapterCapabilitiesV1 {
    return buildBrowserAdapterCapabilities({
        adapterKind: surface.adapterKind,
        supportedTargetKinds: surface.supportedTargetKinds,
        supportedRenderEngines: surface.supportedRenderEngines,
        ...(surface.desktopWebViewSupport === undefined
            ? {}
            : { desktopWebViewSupport: surface.desktopWebViewSupport }),
        ...(surface.nativeViewCaptureHandlerRegistered === undefined
            ? {}
            : { nativeViewCaptureHandlerRegistered: surface.nativeViewCaptureHandlerRegistered }),
    });
}

/**
 * `automationActions` is optional on the schema, so a surface that produced none would silently
 * render as an empty row. Every surface must declare the full map — that is the point of the
 * matrix — so an absent map is a builder defect, not an empty cell.
 */
function automationActionsFor(surface: Surface): BrowserAutomationActionCapabilityMapV1 {
    const actions = capabilitiesFor(surface).automationActions;
    if (!actions) {
        throw new Error(`buildBrowserAdapterCapabilities returned no automationActions for ${surface.label}`);
    }
    return actions;
}

function availableVerbs(actions: BrowserAutomationActionCapabilityMapV1): readonly string[] {
    return CAPABILITY_KINDS.filter((kind) => actions[kind].available === true);
}

function disabledReasons(actions: BrowserAutomationActionCapabilityMapV1): readonly string[] {
    const reasons = new Set<string>();
    for (const kind of CAPABILITY_KINDS) {
        for (const reason of actions[kind].disabledReasons) {
            reasons.add(reason);
        }
    }
    return [...reasons].sort();
}

function cell(values: readonly string[]): string {
    return values.length < 1 ? '_none_' : values.map((value) => `\`${value}\``).join(', ');
}

function renderSurfaceTable(): readonly string[] {
    return [
        '| Surface | Capability flags available | Disabled reasons reported |',
        '|---|---|---|',
        ...SURFACES.map((surface) => {
            const actions = automationActionsFor(surface);
            return `| ${surface.label} | ${cell(availableVerbs(actions))} | ${cell(disabledReasons(actions))} |`;
        }),
    ];
}

function renderVerbTable(): readonly string[] {
    return [
        '| Capability | Available on | Reason where unavailable |',
        '|---|---|---|',
        ...CAPABILITY_KINDS.map((kind) => {
            const surfaces: string[] = [];
            const reasons = new Set<string>();
            for (const surface of SURFACES) {
                const capability = automationActionsFor(surface)[kind];
                if (capability.available === true) {
                    surfaces.push(surface.label);
                    continue;
                }
                for (const reason of capability.disabledReasons) reasons.add(reason);
            }
            const availableOn = surfaces.length < 1
                ? '**nowhere**'
                : surfaces.length === SURFACES.length
                    ? 'every surface'
                    : surfaces.join('<br>');
            return `| \`${kind}\` | ${availableOn} | ${cell([...reasons].sort())} |`;
        }),
    ];
}

function renderActionTable(): readonly string[] {
    return [
        '| Action kind | Installed collector capability | Engine scenarios advertising the injected operation |',
        '|---|---|---|',
        ...BrowserAutomationActionKindV1Schema.options.map((actionKind) => {
            const entry = INJECTED_PAGE_AUTOMATION_ACTIONS.find((candidate) => candidate.action === actionKind);
            const surfaces = entry
                ? SURFACES.filter((surface) => automationActionsFor(surface)[entry.capability].available)
                : [];
            return `| \`${actionKind}\` | ${entry ? `\`${entry.capability}\`` : '_not registered_'} | ${surfaces.length ? surfaces.map((surface) => surface.label).join('<br>') : '_none_'} |`;
        }),
    ];
}

function renderMatrix(): string {
    return [
        `The protocol declares **${BrowserAutomationActionKindV1Schema.options.length} action kinds** and **${CAPABILITY_KINDS.length} adapter capability kinds**. The table covers **${SURFACES.length} engine capability scenarios**, not a fixed surface count.`,
        '',
        '### Surfaces',
        '',
        ...renderSurfaceTable(),
        '',
        '### Capabilities',
        '',
        ...renderVerbTable(),
        '',
        '### Action kinds and in-app injected dispatch',
        '',
        ...renderActionTable(),
        '',
        'Only actions declared by `INJECTED_PAGE_AUTOMATION_ACTIONS` enter the installed collector. '
        + 'Capability flags do not install that collector or prove that a particular page cooperates. '
        + 'Navigation commands use `browser.control` and `navigation.*`; diagnostics element picking '
        + 'uses the diagnostics bridge. Neither is an executable injected automation action. '
        + 'Screenshot references and recording have their own capture owners, not collector action kinds.',
    ].join('\n');
}

function readDocMatrix(): string {
    const doc = readFileSync(DOC_PATH, 'utf8');
    const start = doc.indexOf(TABLE_START);
    const end = doc.indexOf(TABLE_END);
    expect(start, `${DOC_PATH} is missing ${TABLE_START}`).toBeGreaterThanOrEqual(0);
    expect(end, `${DOC_PATH} is missing ${TABLE_END}`).toBeGreaterThan(start);
    return doc.slice(start + TABLE_START.length, end).trim();
}

/**
 * Regeneration path. The doc is derived, so when the capability builder legitimately changes the
 * answer must be re-rendered, not hand-patched from a test diff:
 *
 *     UPDATE_AUTOMATION_VERB_MATRIX=1 vitest run sources/sync/domains/browser/adapters/automationVerbMatrix.closure.test.ts
 *
 * Without the variable this is a pure comparison, so CI still fails on drift.
 */
function writeDocMatrix(matrix: string): void {
    const doc = readFileSync(DOC_PATH, 'utf8');
    const start = doc.indexOf(TABLE_START);
    const end = doc.indexOf(TABLE_END);
    expect(start, `${DOC_PATH} is missing ${TABLE_START}`).toBeGreaterThanOrEqual(0);
    expect(end, `${DOC_PATH} is missing ${TABLE_END}`).toBeGreaterThan(start);
    writeFileSync(
        DOC_PATH,
        `${doc.slice(0, start + TABLE_START.length)}\n${matrix}\n${doc.slice(end)}`,
        'utf8',
    );
}

describe('browser automation verb matrix (UB-1)', () => {
    it('publishes the matrix the capability builder actually produces', () => {
        const matrix = renderMatrix();
        if (process.env.UPDATE_AUTOMATION_VERB_MATRIX === '1') writeDocMatrix(matrix);
        expect(readDocMatrix()).toBe(matrix);
    });

    it('keeps every desktop and streamed surface honest about why a verb is off', () => {
        // The failure mode UB-1 names: a surface that reports zero available verbs and zero
        // reasons is a silent dead end for an agent.
        for (const surface of SURFACES) {
            const actions = automationActionsFor(surface);
            if (availableVerbs(actions).length > 0) continue;
            expect(disabledReasons(actions), `${surface.label} disables everything with no reason`)
                .not.toEqual([]);
        }
    });
});
