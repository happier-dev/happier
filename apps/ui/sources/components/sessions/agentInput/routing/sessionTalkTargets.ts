import * as React from 'react';
import type { ActionSessionAddress } from '@happier-dev/protocol/actions/executor/types';
import type { SessionTargetSelectorV1 } from '@happier-dev/protocol/actions/sessionTargetV1';
import type { SessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';

import { isAccountFollowConfigurationChangeRelevant, isSessionFollowAccountChangeRelevant } from '@/components/sessions/follow/sessionFollowAccountChange';
import { useSessionFollowRules } from '@/components/sessions/follow/useSessionFollowRules';
import type { SessionFollowRulesReadResult } from '@/sync/api/session/sessionFollowRulesApi';
import { createDefaultActionExecutor, type UiSessionTargetPreview } from '@/sync/ops/actions/defaultActionExecutor';
import { useServerCredentialAccountScopeBinding, type ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { useSessionDisplayTitles } from '@/utils/sessions/sessionDisplayTitle';
import { t } from '@/text';

export type SessionTalkSelector = Exclude<SessionTargetSelectorV1['selector'], 'self'>;
export type SessionTalkTargetPreview = Readonly<{
    target: SessionTargetSelectorV1 | null;
    coverage: 'complete' | 'partial' | 'unavailable';
    addresses: readonly ActionSessionAddress[];
    names: readonly string[];
    loading: boolean;
    error: string | null;
}>;
export type SessionTalkTargetOptions = Readonly<{
    /** The picker/open-intent owner supplies demand; closed controls do no work. */
    enabled?: boolean;
    /** A sub-step demands only the selectors it presents; the parent retains its rule input. */
    selectors?: readonly SessionTalkSelector[];
    matchingFilter?: SessionListFilterV1;
    discussionId?: string;
}>;
type PreviewState = Omit<SessionTalkTargetPreview, 'target' | 'names'>;
export type SessionTalkTargets = Readonly<Record<SessionTalkSelector, SessionTalkTargetPreview>> & Readonly<{ refresh: () => void }>;

const SELECTORS = ['manager', 'workers', 'siblings', 'followers', 'following', 'matching', 'discussion'] as const;
const EMPTY_ADDRESSES: readonly ActionSessionAddress[] = [];
const UNAVAILABLE: PreviewState = { coverage: 'unavailable', addresses: EMPTY_ADDRESSES, loading: false, error: null };
function mapSelectorPreviews<T>(read: (selector: SessionTalkSelector) => T): Readonly<Record<SessionTalkSelector, T>> {
    return { manager: read('manager'), workers: read('workers'), siblings: read('siblings'),
        followers: read('followers'), following: read('following'), matching: read('matching'), discussion: read('discussion') };
}

function useSelectorPreview(target: SessionTargetSelectorV1 | null, context: Readonly<{
    enabled: boolean;
    binding: ServerCredentialAccountScopeBinding | null;
    scopeKey: string;
    sessionId: string;
    resolving: boolean;
    revision: number;
    rules?: SessionFollowRulesReadResult | null;
}>): PreviewState {
    const { enabled, binding, scopeKey, sessionId, resolving, revision, rules } = context;
    // Each selector owns only its own inputs. Editing Matching must neither retire
    // another selector's in-flight read nor discard its last-good preview.
    const targetKey = JSON.stringify(target);
    const stableTarget = React.useMemo(() => JSON.parse(targetKey) as SessionTargetSelectorV1 | null, [targetKey]);
    const key = JSON.stringify([scopeKey, targetKey]);
    const [state, setState] = React.useState<{ key: string; preview: PreviewState }>({ key: '', preview: UNAVAILABLE });
    const refreshRef = React.useRef<() => void>(() => {});
    const previousRevision = React.useRef(revision);
    React.useEffect(() => {
        if (!enabled || rules === null || !binding?.isCurrent() || !stableTarget) return;
        const abort = new AbortController();
        const isCurrent = () => !abort.signal.aborted && binding.isCurrent();
        const retirement = binding.onRetire(() => {
            abort.abort();
            setState({ key, preview: UNAVAILABLE });
        });
        const publish = (result: UiSessionTargetPreview) => {
            if (!isCurrent()) return;
            setState(current => {
                const previous = current.key === key ? current.preview : UNAVAILABLE;
                return { key, preview: result.coverage === 'complete'
                    ? { ...result, loading: false }
                    : { coverage: previous.addresses.length ? 'partial' : 'unavailable', addresses: previous.addresses,
                        loading: false, error: result.error } };
            });
        };
        // Like Follow's list reader, finish useful work and fold overlapping
        // Account wakes into one trailing read. A wake is not scope retirement:
        // aborting here can starve previews while the Home keeps changing.
        let running = false;
        let dirty = false;
        const read = () => {
            if (!isCurrent()) return;
            if (running) { dirty = true; return; }
            running = true;
            void (async () => {
                try {
                    do {
                        dirty = false;
                        setState(current => ({ key, preview: { ...(current.key === key ? current.preview : UNAVAILABLE),
                            loading: true, error: null } }));
                        try {
                            publish(await createDefaultActionExecutor().previewSessionTargets(stableTarget, {
                                surface: 'ui', serverId: binding.serverId, defaultSessionId: sessionId,
                                expectedAccountId: binding.accountId, signal: abort.signal,
                            }, rules ? { rules } : undefined));
                        } catch {
                            publish({ coverage: 'unavailable', addresses: [], error: 'session_target_unavailable' });
                        }
                    } while (dirty && isCurrent());
                } finally { running = false; }
            })();
        };
        refreshRef.current = read;
        read();
        return () => { abort.abort(); retirement.dispose(); refreshRef.current = () => {}; };
    }, [enabled, binding, key, stableTarget, sessionId, rules]);
    React.useEffect(() => {
        if (previousRevision.current === revision) return;
        previousRevision.current = revision;
        refreshRef.current();
    }, [revision]);
    return enabled && binding?.isCurrent() && state.key === key ? state.preview : { ...UNAVAILABLE,
        loading: enabled && Boolean(stableTarget) && (resolving || Boolean(binding?.isCurrent())),
        error: !stableTarget ? 'selection_required'
            : enabled && !resolving && !binding?.isCurrent() ? 'session_target_unavailable' : null };
}

/**
 * Preview the same authorized selectors as Action admission. Addressing never depends on loaded rows;
 * local title projections only decorate the already-resolved addresses. Partial results are retained
 * last-known previews, never a sendable subset. Final submission still prepares the original selector.
 */
export function useSessionTalkTargets(sessionId: string, serverId: string | null, options: SessionTalkTargetOptions = {}): SessionTalkTargets {
    const enabled = options.enabled !== false;
    const { binding, resolution } = useServerCredentialAccountScopeBinding(enabled ? serverId : null);
    const ruleInputs = useSessionFollowRules(serverId, enabled);
    const targetKey = JSON.stringify([sessionId, options.matchingFilter ?? null, options.discussionId ?? null]);
    const targets = React.useMemo((): Readonly<Record<SessionTalkSelector, SessionTargetSelectorV1 | null>> => {
        const [of, matchingFilter, discussionId] = JSON.parse(targetKey) as [string, SessionListFilterV1 | null, string | null];
        return { manager: { selector: 'manager', of }, workers: { selector: 'workers', of }, siblings: { selector: 'siblings', of },
            followers: { selector: 'followers', of }, following: { selector: 'following', of },
            matching: matchingFilter ? { selector: 'matching', of, filter: matchingFilter } : null,
            discussion: discussionId ? { selector: 'discussion', of, discussionId } : null };
    }, [targetKey]);
    const scopeKey = JSON.stringify([serverId, binding?.accountId, binding?.revision]);
    const [revision, invalidate] = React.useReducer((value: Readonly<{ all: number; corpus: number }>, configuration: boolean) => ({
        all: value.all + 1, corpus: value.corpus + (configuration ? 0 : 1),
    }), { all: 0, corpus: 0 });
    const refresh = React.useCallback(() => { invalidate(true); void ruleInputs.refresh(); }, [ruleInputs.refresh]);
    React.useEffect(() => {
        if (!enabled || !binding?.isCurrent()) return;
        return subscribeHomeAccountChange(event => {
            if (!binding.isCurrent() || !areServerProfileIdentifiersEquivalent(event.serverId, binding.serverId)) return;
            // Discussion participants have independent membership; all Session
            // and Follow corpus changes use the same relevance owner as rule counts.
            const configuration = isAccountFollowConfigurationChangeRelevant(event);
            if (!configuration && !event.changeKinds?.includes('discussion') && !isSessionFollowAccountChangeRelevant(event)) return;
            invalidate(configuration);
        }, { reconnect: 'refresh' });
    }, [enabled, binding]);
    const previewContext = (selector: SessionTalkSelector) => {
        const usesRules = selector === 'followers' || selector === 'following' || selector === 'matching';
        return { enabled: enabled && (options.selectors?.includes(selector) ?? true),
            binding, scopeKey, sessionId, resolving: resolution.kind === 'resolving',
            revision: usesRules ? revision.corpus : revision.all,
            ...(usesRules ? { rules: ruleInputs.snapshot } : {}) };
    };
    const previews = {
        manager: useSelectorPreview(targets.manager, previewContext('manager')),
        workers: useSelectorPreview(targets.workers, previewContext('workers')),
        siblings: useSelectorPreview(targets.siblings, previewContext('siblings')),
        followers: useSelectorPreview(targets.followers, previewContext('followers')),
        following: useSelectorPreview(targets.following, previewContext('following')),
        matching: useSelectorPreview(targets.matching, previewContext('matching')),
        discussion: useSelectorPreview(targets.discussion, previewContext('discussion')),
    };
    const addresses = SELECTORS.flatMap(selector => previews[selector].addresses);
    const titles = useSessionDisplayTitles(addresses);
    let offset = 0;
    return { ...mapSelectorPreviews<SessionTalkTargetPreview>(selector => {
        const preview = previews[selector];
        const names = preview.addresses.map(() => titles[offset++] ?? t('session.untitled'));
        return { ...preview, names, target: targets[selector] };
    }), refresh };
}
