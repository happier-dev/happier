import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
    AssignableSessionRoleSchema,
    applySessionRoleV1ToMetadata,
    applySessionRoleChangeV1ToMetadata,
    addCustomSessionRoleProfileV1,
    buildSessionRoleAssignmentMessageV1,
    buildSessionRoleAssignmentV1,
    buildSessionRoleClearedMessageV1,
    buildSessionRolePromptBlockTextV1,
    buildExecutionRunRolePromptBlockTextV1,
    createCustomSessionRoleIdV1,
    DEFAULT_SESSION_ROLE_INSTRUCTIONS_V1,
    DEFAULT_SESSION_ROLE_PROFILES_V1,
    SEEDED_PRODUCT_LEAD_ROLE_PROFILE_V1,
    FreshAssignableSessionRoleV1Schema,
    listAssignableSessionRoleProfilesV1,
    readBuiltInSessionRoleDisplayNameV1,
    removeCustomSessionRoleProfileV1,
    resolveAssignableSessionRoleProfileV1,
    SESSION_ROLES,
    readSessionRoleAssignmentV1,
    readSessionRoleV1,
    resolveSessionRoleInstructionsV1,
    setBuiltInSessionRoleDisplayNameV1,
    setBuiltInSessionRoleProfileV1,
    setSessionRoleProfileInstructionsV1,
    planSessionRoleChangeV1,
    updateCustomSessionRoleProfileV1,
} from './sessionRole.js';

const assignment = (role: 'planner' | 'worker' | 'reviewer', instructions: string, assignmentId: string) =>
    buildSessionRoleAssignmentV1({ role, instructions, assignmentId, assignedAt: 1 });

describe('session role metadata', () => {
    it('requires a complete retained instruction identity only for fresh assignment admission', () => {
        const complete = {
            v: 1 as const,
            role: 'project_lead' as const,
            instructions: 'Coordinate this bounded delivery.',
            assignmentId: 'assignment-1',
            assignedAt: 7,
        };
        expect(FreshAssignableSessionRoleV1Schema.safeParse(complete).success).toBe(true);
        for (const incomplete of [
            { ...complete, instructions: '' },
            { ...complete, instructions: '   ' },
            { ...complete, assignmentId: '' },
            { ...complete, assignmentId: '   ' },
            { v: 1, role: 'project_lead', instructions: complete.instructions, assignmentId: complete.assignmentId },
        ]) {
            expect(FreshAssignableSessionRoleV1Schema.safeParse(incomplete).success).toBe(false);
        }
        // The history reader stays permissive for an already persisted label-only snapshot.
        expect(readSessionRoleV1({ sessionRoleV1: { v: 1, role: 'reviewer' } })).toBe('reviewer');
    });

    it('generates and validates stable custom role ids without admitting arbitrary role strings', () => {
        const id = createCustomSessionRoleIdV1('123E4567-E89B-12D3-A456-426614174000');
        expect(id).toBe('custom:123e4567-e89b-12d3-a456-426614174000');
        expect(AssignableSessionRoleSchema.safeParse(id).success).toBe(true);
        expect(AssignableSessionRoleSchema.safeParse('custom:architect').success).toBe(false);
        expect(AssignableSessionRoleSchema.safeParse('delegate').success).toBe(false);
        expect(() => createCustomSessionRoleIdV1('not-a-uuid')).toThrow();
    });

    it('edits fixed built-in prompts and colors without making built-ins renameable or removable', () => {
        const existing = {
            v: 1 as const,
            instructionsByRole: { delegate: 'Legacy override.', futureRole: 'Future.' },
            colorsByRole: { reviewer: '#112233', futureRole: '#abcdef' },
            futureTop: { keep: true },
        };
        const next = setBuiltInSessionRoleProfileV1(existing, 'reviewer', {
            instructions: 'Review carefully.',
            color: '#AABBCC',
        });
        expect(next).toMatchObject({
            instructionsByRole: { delegate: 'Legacy override.', futureRole: 'Future.', reviewer: 'Review carefully.' },
            colorsByRole: { reviewer: '#aabbcc', futureRole: '#abcdef' },
            futureTop: { keep: true },
        });
        expect(SESSION_ROLES).toEqual(['planner', 'project_lead', 'worker', 'reviewer']);
    });

    it('adds, edits, and removes first-class custom roles while preserving passthrough data', () => {
        const id = createCustomSessionRoleIdV1('123e4567-e89b-12d3-a456-426614174000');
        const base = { v: 1 as const, instructionsByRole: { reviewer: 'Keep.' }, futureTop: true };
        const added = addCustomSessionRoleProfileV1(base, {
            id,
            name: 'Architect',
            instructions: 'Design the system.',
            color: '#123456',
            futureProfile: 'keep',
        });
        expect(added).toMatchObject({
            instructionsByRole: { reviewer: 'Keep.' },
            customRoles: [{ id, name: 'Architect', instructions: 'Design the system.', color: '#123456', futureProfile: 'keep' }],
            futureTop: true,
        });
        const edited = updateCustomSessionRoleProfileV1(added, id, { name: 'System Architect', instructions: 'Design safely.', color: '#ABCDEF' });
        expect(edited.customRoles?.[0]).toEqual({ id, name: 'System Architect', instructions: 'Design safely.', color: '#abcdef', futureProfile: 'keep' });
        const removed = removeCustomSessionRoleProfileV1(edited, id);
        expect(removed.customRoles).toEqual([]);
        expect(removed).toMatchObject({ instructionsByRole: { reviewer: 'Keep.' }, futureTop: true });
        expect(() => addCustomSessionRoleProfileV1(added, {
            id,
            name: 'Duplicate',
            instructions: 'No.',
            color: '#000000',
        })).toThrow('custom-session-role-already-exists');
    });

    it('snapshots a custom identity and keeps it readable and prompt-resumable after profile deletion', () => {
        const id = createCustomSessionRoleIdV1('123e4567-e89b-12d3-a456-426614174000');
        const profiles = addCustomSessionRoleProfileV1(undefined, {
            id,
            name: 'Architect',
            instructions: 'Design the system.',
            color: '#123456',
        });
        const settings = { sessionRoleProfilesV1: profiles };
        const planned = planSessionRoleChangeV1({ role: id, settings, changeId: 'custom-a1', at: 7 });
        expect(planned).not.toBeNull();
        expect(planned?.assignment).toEqual({
            v: 1,
            role: id,
            name: 'Architect',
            color: '#123456',
            instructions: 'Design the system.',
            assignmentId: 'custom-a1',
            assignedAt: 7,
        });
        const metadata = { sessionRoleV1: planned?.assignment, sessionOriginV1: { v: 1, kind: 'agent', creatorSessionId: 'p1' } };
        expect(readSessionRoleAssignmentV1(metadata)).toMatchObject({ role: id, name: 'Architect', color: '#123456', instructions: 'Design the system.' });

        const editedProfiles = updateCustomSessionRoleProfileV1(profiles, id, {
            name: 'Principal Architect',
            instructions: 'Design the next system.',
            color: '#abcdef',
        });
        expect(planSessionRoleChangeV1({ role: id, settings: { sessionRoleProfilesV1: editedProfiles }, changeId: 'custom-reapply', at: 8 })?.assignment)
            .toMatchObject({ role: id, name: 'Principal Architect', color: '#abcdef', instructions: 'Design the next system.' });
        expect(readSessionRoleAssignmentV1(metadata)).toMatchObject({ role: id, name: 'Architect', color: '#123456', instructions: 'Design the system.' });

        const deletedSettings = { sessionRoleProfilesV1: removeCustomSessionRoleProfileV1(profiles, id) };
        expect(planSessionRoleChangeV1({ role: id, settings: deletedSettings, changeId: 'custom-a2', at: 8 })).toBeNull();
        expect(readSessionRoleAssignmentV1(metadata)).toMatchObject({ role: id, name: 'Architect', color: '#123456', instructions: 'Design the system.' });
        expect(buildSessionRolePromptBlockTextV1(metadata)).toContain('Current role assignment: Architect\n\nDesign the system.');

        const first = applySessionRoleChangeV1ToMetadata(
            { sessionOriginV1: metadata.sessionOriginV1 },
            planSessionRoleChangeV1({ role: id, settings, changeId: 'custom-a3', at: 9, actionRequestId: 'request-1' })!,
            { actionRequestId: 'request-1' },
        );
        const resumedPlan = planSessionRoleChangeV1({
            role: id,
            settings: deletedSettings,
            changeId: 'custom-a4',
            at: 10,
            actionRequestId: 'request-1',
            resumeExistingAssignment: true,
        });
        expect(resumedPlan).not.toBeNull();
        const resumed = applySessionRoleChangeV1ToMetadata(first.metadata, resumedPlan!, { actionRequestId: 'request-1', resume: true });
        expect(resumed.outcome).toBe('replayed');
        expect(resumed.metadata).toBe(first.metadata);
        expect(resumed.plan?.assignment).toEqual((first.metadata as Record<string, unknown>).sessionRoleV1);
        expect(resumed.plan?.message).toContain('Role assignment: Architect\n\nDesign the system.');
    });

    it('lists only current built-ins and catalog custom roles while existing snapshots remain authoritative', () => {
        const id = createCustomSessionRoleIdV1('123e4567-e89b-12d3-a456-426614174000');
        const profiles = addCustomSessionRoleProfileV1({
            v: 1,
            instructionsByRole: { planner: 'New planner default.', delegate: 'Legacy delegate override.' },
            colorsByRole: { planner: '#010203' },
        }, { id, name: 'Architect', instructions: 'Design.', color: '#123456' });
        expect(listAssignableSessionRoleProfilesV1({ sessionRoleProfilesV1: profiles }).map((profile) => profile.id))
            .toEqual(['planner', 'project_lead', 'worker', 'reviewer', id]);
        expect(listAssignableSessionRoleProfilesV1({ sessionRoleProfilesV1: removeCustomSessionRoleProfileV1(profiles, id) }).map((profile) => profile.id))
            .toEqual(['planner', 'project_lead', 'worker', 'reviewer']);

        const active = buildSessionRoleAssignmentV1({ role: 'planner', instructions: 'OLD FULL-SCOPE PLANNER', assignmentId: 'old', assignedAt: 1 });
        expect(readSessionRoleAssignmentV1({ sessionRoleV1: active })?.instructions).toBe('OLD FULL-SCOPE PLANNER');
        expect(setBuiltInSessionRoleProfileV1(profiles, 'planner', { instructions: 'Future only.', color: '#ffffff' })).not.toBe(profiles);
        expect(readSessionRoleAssignmentV1({ sessionRoleV1: active })?.instructions).toBe('OLD FULL-SCOPE PLANNER');
    });

    it('offers the four current roles while retaining legacy delegate snapshots byte-for-byte', () => {
        expect(SESSION_ROLES).toEqual(['planner', 'project_lead', 'worker', 'reviewer']);
        const legacyPlanner = { v: 1 as const, role: 'planner' as const, instructions: 'OLD FULL-SCOPE PLANNER', assignmentId: 'old-p', assignedAt: 1, future: true };
        const legacyDelegate = { v: 1 as const, role: 'delegate' as const, instructions: 'OLD DELEGATE', assignmentId: 'old-d', assignedAt: 2, future: true };
        expect(readSessionRoleAssignmentV1({ sessionRoleV1: legacyPlanner })).toEqual({ role: 'planner', instructions: 'OLD FULL-SCOPE PLANNER', assignmentId: 'old-p' });
        expect(readSessionRoleAssignmentV1({ sessionRoleV1: legacyDelegate })).toEqual({ role: 'delegate', instructions: 'OLD DELEGATE', assignmentId: 'old-d' });
        expect(applySessionRoleV1ToMetadata({ sessionRoleV1: legacyPlanner, placement: 'root' }, legacyPlanner).sessionRoleV1).toBe(legacyPlanner);
    });

    it('uses the exact generic defaults and Repo Admin template without changing the native role catalog or legacy Delegate', () => {
        const expectedHashes = {
            planner: 'fbd1dfc4a3305843dbb07865f1f27554f7f3ad12817f6ea19bd9f02cc5343294',
            project_lead: 'b41552329a94f1af1d70d23c1a9ae0964dd7f7384e4b80e39395b1ac0ea76668',
            worker: 'c5f927eba0ccd1668887e7587a1d608f7d4cf5bb0d370a1c97516c0f67f4ce84',
            reviewer: 'a3ace9d9753a016ae60e6d0171df22f9f482fc1f462f094fdb7deb644e11e047',
        } as const;
        for (const role of SESSION_ROLES) {
            expect(createHash('sha256').update(DEFAULT_SESSION_ROLE_INSTRUCTIONS_V1[role], 'utf8').digest('hex'))
                .toBe(expectedHashes[role]);
        }
        expect(SESSION_ROLES).toEqual(['planner', 'project_lead', 'worker', 'reviewer']);
        expect(SEEDED_PRODUCT_LEAD_ROLE_PROFILE_V1).toMatchObject({
            id: 'custom:7ddd6f5b-cd52-4226-b661-8a397752e1fe',
            name: 'Repo Admin',
            color: '#5c6bc0',
        });
        expect(createHash('sha256').update(SEEDED_PRODUCT_LEAD_ROLE_PROFILE_V1.instructions, 'utf8').digest('hex'))
            .toBe('fac16d6d417ceab43c89eaf04ec6d46669f90139b177fb6fbba262d0c93ec842');
        expect(DEFAULT_SESSION_ROLE_PROFILES_V1).toEqual({ v: 1, instructionsByRole: {} });
        expect(DEFAULT_SESSION_ROLE_INSTRUCTIONS_V1.delegate)
            .toBe('Implement the assigned scope. Choose the simplest complete solution, ask when ambiguity materially changes the outcome, use relevant skills, and report findings or proposed skill improvements to the Planner. Work only within the permissions actually granted to this session.');
    });

    it('aligns leadership, planning, delivery and review boundaries while preserving notice safeguards and account settings', () => {
        const planner = DEFAULT_SESSION_ROLE_INSTRUCTIONS_V1.planner;
        expect(planner).toContain('bounded planning request');
        expect(planner).toContain('planning only');
        expect(planner).toContain('the assigned Lead decides and dispatches');
        expect(planner).toContain('no implementation, staffing, dispatch, delivery coordination, final delivery review, PR submission, merge or release');

        const projectLead = DEFAULT_SESSION_ROLE_INSTRUCTIONS_V1.project_lead;
        expect(projectLead).toContain('Project Manager and chief engineer');
        expect(projectLead).toContain('Tackle small bounded tasks yourself');
        expect(projectLead).toContain('Do not create a Planner or Worker merely to satisfy a hierarchy');
        expect(projectLead).toContain('Your self-check of authored code is not independent review');
        expect(projectLead).toContain('Repo Admin owns shared repository integration, packaging and release sequencing');
        expect(projectLead).toContain('The user sets cross-repository priorities');
        expect(projectLead).toContain('before substantive implementation');
        expect(projectLead).toContain('session.spawn_new');
        expect(projectLead).toContain('explicit stable role ids: worker, reviewer, planner when needed');
        expect(projectLead).toContain('custom:<uuid>');
        expect(projectLead).toContain("each child's stable role and returned session ID");
        expect(projectLead).toContain('exact role-aware spawn receipt');
        expect(projectLead).toContain('reachable and behaving within role');
        expect(projectLead).toContain('report the exact failure');
        expect(projectLead).toContain('never use titles or tags to conceal it');
        expect(projectLead).toContain('Inspect every final worker report yourself and acknowledge it');
        expect(projectLead).toContain('supported authorized execution locations');
        expect(projectLead).toContain('selected role instructions');
        expect(projectLead).toContain('configured model/permission modes');
        expect(projectLead).toContain('naming, grouping and pinning through supported controls');

        for (const role of ['worker', 'reviewer'] as const) {
            const instructions = DEFAULT_SESSION_ROLE_INSTRUCTIONS_V1[role];
            expect(instructions).toContain('delivery Lead session ID');
            expect(instructions).toContain('session.message.send');
            expect(instructions).toContain('kind: "notice"');
            expect(instructions).toContain('from');
            expect(instructions).toContain('visibility only');
            expect(instructions).toContain('cannot wake');
            expect(instructions).toContain('override settings');
            expect(instructions).toContain('user instruction');
        }
        expect(DEFAULT_SESSION_ROLE_INSTRUCTIONS_V1.worker).toContain('Report to exactly one assigned delivery Lead');
        expect(DEFAULT_SESSION_ROLE_INSTRUCTIONS_V1.worker).toContain('Do not dispatch reviewers or other workers');
        expect(DEFAULT_SESSION_ROLE_INSTRUCTIONS_V1.reviewer).toContain('must be independent of the incoming implementation author');
        expect(DEFAULT_SESSION_ROLE_INSTRUCTIONS_V1.reviewer).toContain('Make a repair yourself only when explicitly assigned');
        expect(DEFAULT_SESSION_ROLE_INSTRUCTIONS_V1.reviewer).toContain('Use the selected provider only within its supported capabilities');

        for (const instructions of [
            SEEDED_PRODUCT_LEAD_ROLE_PROFILE_V1.instructions,
            ...SESSION_ROLES.map((role) => DEFAULT_SESSION_ROLE_INSTRUCTIONS_V1[role]),
        ]) {
            expect(instructions).not.toMatch(/\b(?:Zac|Rivet|River|assistant|coordinator)\b/i);
        }

        const existing = { v: 1 as const, instructionsByRole: { delegate: 'Legacy custom.', reviewer: 'Custom review.', futureRole: 'Future.' }, futureTop: { keep: true } };
        const next = setSessionRoleProfileInstructionsV1(existing, 'planner', 'Custom plan.');
        expect(next).toMatchObject({ instructionsByRole: { delegate: 'Legacy custom.', reviewer: 'Custom review.', futureRole: 'Future.', planner: 'Custom plan.' }, futureTop: { keep: true } });
    });

    it('reads absent, malformed and unknown future roles as no role', () => {
        for (const metadata of [null, undefined, 'delegate', {}, { sessionRoleV1: null },
            { sessionRoleV1: { v: 2, role: 'delegate' } },
            { sessionRoleV1: { v: 1, role: 'architect' } },
            { sessionRoleV1: { v: 1 } },
            { sessionRoleV1: 'delegate' }]) {
            expect(readSessionRoleV1(metadata)).toBeNull();
            expect(readSessionRoleAssignmentV1(metadata)).toBeNull();
        }
        expect(readSessionRoleV1({ sessionRoleV1: { v: 1, role: 'reviewer', future: true } })).toBe('reviewer');
    });

    it('retains the exact instruction snapshot, and degrades a role without valid instructions to no guidance', () => {
        const metadata = { sessionRoleV1: assignment('reviewer', 'Review the plan.', 'a-1') };
        expect(readSessionRoleAssignmentV1(metadata)).toEqual({ role: 'reviewer', instructions: 'Review the plan.', assignmentId: 'a-1' });
        expect(readSessionRoleAssignmentV1({ sessionRoleV1: { v: 1, role: 'reviewer', instructions: 42 } }))
            .toEqual({ role: 'reviewer', instructions: null, assignmentId: null });
        expect(readSessionRoleV1({ sessionRoleV1: { v: 1, role: 'reviewer', instructions: 42 } })).toBe('reviewer');
    });

    it('assigns, reassigns, reapplies and clears only the role, preserving provenance and unrelated keys', () => {
        const origin = { v: 1, kind: 'agent', creatorSessionId: 'planner' };
        const base = { path: '/repo', sessionOriginV1: origin, summary: { text: 'Title', updatedAt: 1 }, futureKey: { x: 1 } };
        const planner = applySessionRoleV1ToMetadata(base, assignment('planner', 'Plan.', 'a-1'));
        expect(planner).toEqual({ ...base, sessionRoleV1: assignment('planner', 'Plan.', 'a-1') });
        expect(planner.sessionOriginV1).toBe(origin);
        const reviewer = applySessionRoleV1ToMetadata(planner, assignment('reviewer', 'Review.', 'a-2'));
        expect(reviewer.sessionRoleV1).toEqual(assignment('reviewer', 'Review.', 'a-2'));
        // Reapplying the same role replaces the snapshot so edited defaults can be delivered explicitly.
        const reapplied = applySessionRoleV1ToMetadata(reviewer, assignment('reviewer', 'Review harder.', 'a-3'));
        expect(reapplied.sessionRoleV1).toEqual(assignment('reviewer', 'Review harder.', 'a-3'));
        const cleared = applySessionRoleV1ToMetadata(reapplied, null);
        expect(cleared).toEqual(base);
        expect(applySessionRoleV1ToMetadata(base, null)).toBe(base);
    });

    it('applies every first execution as its own change; only an explicit resume of the recorded request replays it', () => {
        const settingsAt = (reviewer: string) => ({ sessionRoleProfilesV1: { v: 1, instructionsByRole: { reviewer } } });
        const plan = (changeId: string, text: string) =>
            planSessionRoleChangeV1({ role: 'reviewer', settings: settingsAt(text), changeId, at: 1, actionRequestId: '7' });

        const first = applySessionRoleChangeV1ToMetadata({ path: '/repo' }, plan('c1', 'Original.'), { actionRequestId: '7' });
        expect(first.outcome).toBe('applied');
        expect(first.metadata.sessionRoleV1).toMatchObject({ assignmentId: 'c1', actionRequestId: '7', instructions: 'Original.' });

        // The same external id without resume is correlation only: a recycled id is a new change.
        const recycled = applySessionRoleChangeV1ToMetadata(first.metadata, plan('c2', 'Edited.'), { actionRequestId: '7' });
        expect(recycled.outcome).toBe('applied');
        expect(recycled.metadata.sessionRoleV1).toMatchObject({ assignmentId: 'c2', instructions: 'Edited.' });

        const resumed = applySessionRoleChangeV1ToMetadata(recycled.metadata, plan('c3', 'Later.'), { actionRequestId: '7', resume: true });
        expect(resumed.outcome).toBe('replayed');
        expect(resumed.metadata).toBe(recycled.metadata);
        expect(resumed.plan).toMatchObject({ localId: 'session-role:c2', message: buildSessionRoleAssignmentMessageV1({ role: 'reviewer', instructions: 'Edited.' }) });

        expect(applySessionRoleChangeV1ToMetadata(recycled.metadata, plan('c4', 'Later.'), { actionRequestId: '6', resume: true }))
            .toMatchObject({ outcome: 'not_current', plan: null });

        // A clear retains no identity, so no resumed clear can be resolved, even when no role is set.
        const clear = planSessionRoleChangeV1({ role: null, settings: null, changeId: 'c5', at: 1, actionRequestId: '8' });
        const empty = { path: '/repo' };
        expect(applySessionRoleChangeV1ToMetadata(empty, clear, { actionRequestId: '8', resume: true }))
            .toEqual({ outcome: 'not_current', metadata: empty, plan: null });
    });

    it('resolves an account override over the built-in default, and an empty override to the default', () => {
        expect(resolveSessionRoleInstructionsV1(null, 'planner')).toBe(DEFAULT_SESSION_ROLE_INSTRUCTIONS_V1.planner);
        const settings = { sessionRoleProfilesV1: { v: 1, instructionsByRole: { reviewer: '  Custom review rules.  ', delegate: '   ' } } };
        expect(resolveSessionRoleInstructionsV1(settings, 'reviewer')).toBe('Custom review rules.');
        expect(resolveSessionRoleInstructionsV1(settings, 'delegate')).toBe(DEFAULT_SESSION_ROLE_INSTRUCTIONS_V1.delegate);
        expect(resolveSessionRoleInstructionsV1({ sessionRoleProfilesV1: 'broken' }, 'reviewer'))
            .toBe(DEFAULT_SESSION_ROLE_INSTRUCTIONS_V1.reviewer);
    });

    it('saves and resets one role profile, treating blank or default text as no override', () => {
        const saved = setSessionRoleProfileInstructionsV1(undefined, 'reviewer', '  Review it.  ');
        expect(saved).toEqual({ v: 1, instructionsByRole: { reviewer: 'Review it.' } });
        const both = setSessionRoleProfileInstructionsV1(saved, 'planner', 'Plan it.');
        expect(setSessionRoleProfileInstructionsV1(both, 'reviewer', null)).toEqual({ v: 1, instructionsByRole: { planner: 'Plan it.' } });
        expect(setSessionRoleProfileInstructionsV1(both, 'planner', DEFAULT_SESSION_ROLE_INSTRUCTIONS_V1.planner).instructionsByRole).toEqual({ reviewer: 'Review it.' });
        expect(setSessionRoleProfileInstructionsV1(both, 'planner', '   ').instructionsByRole).toEqual({ reviewer: 'Review it.' });
    });

    it('plans assign and explicit clear identically for every caller: snapshot, visible message, idempotent id', () => {
        const settings = { sessionRoleProfilesV1: { v: 1, instructionsByRole: { worker: 'Account worker rules.' } } };
        const assign = planSessionRoleChangeV1({ role: 'worker', settings, changeId: 'c-1', at: 7 });
        expect(assign).toEqual({
            assignment: { v: 1, role: 'worker', instructions: 'Account worker rules.', assignmentId: 'c-1', assignedAt: 7 },
            message: buildSessionRoleAssignmentMessageV1({ role: 'worker', instructions: 'Account worker rules.' }),
            localId: 'session-role:c-1',
        });
        expect(planSessionRoleChangeV1({ role: null, settings, changeId: 'c-2', at: 8 })).toEqual({
            assignment: null,
            message: buildSessionRoleClearedMessageV1(),
            localId: 'session-role-cleared:c-2',
        });
    });

    it('builds visible assignment and clearing instructions that never claim new permissions', () => {
        const message = buildSessionRoleAssignmentMessageV1({ role: 'reviewer', instructions: 'Review.' });
        expect(message.startsWith('Role assignment: Reviewer\n\nReview.\n\n')).toBe(true);
        expect(message).toContain('until this session is reassigned or the role is cleared');
        expect(message).toContain('does not change your permissions, tools, model, or ownership');
        const cleared = buildSessionRoleClearedMessageV1();
        expect(cleared).toContain('Role assignment cleared');
        expect(cleared).toContain('other instructions');
    });
});

describe('run-scoped role rendering', () => {
    it('renders catalog instructions with a run scope note instead of the session scope note', () => {
        const block = buildExecutionRunRolePromptBlockTextV1({ id: 'reviewer', name: 'Reviewer', instructions: '  Review it.  ' });
        expect(block.startsWith('Current run role: Reviewer\n\nReview it.\n\n')).toBe(true);
        expect(block).toContain('applies to this run only');
        expect(block).toContain("run's output contract takes precedence");
        expect(block).not.toContain('until this session is reassigned');
        expect(buildExecutionRunRolePromptBlockTextV1({ id: 'custom:0b8f1a2c-3d4e-4f5a-8b6c-7d8e9f0a1b2c', name: 'Architect', instructions: 'Design.' }))
            .toContain('Current run role: Architect');
    });
});

describe('Project Manager visible-agents guidance', () => {
    it('binds assembled children, prefers visible runs, verifies echoes, and confirms by readback', () => {
        const projectLead = DEFAULT_SESSION_ROLE_INSTRUCTIONS_V1.project_lead;
        expect(projectLead).toContain('team was already assembled');
        expect(projectLead).toContain('existing Worker/Reviewer placeholders');
        expect(projectLead).toContain('visibility: "session"');
        expect(projectLead).toContain('targetSessionId');
        expect(projectLead).toContain('current available model/provider defaults');
        expect(projectLead).toContain('missing echo is an unassigned run');
        expect(projectLead).toContain('session.status.get');
        expect(projectLead).toContain('resume the same action request and inspect its outcome before another start');
        expect(projectLead).toContain('Author the plan yourself unless a planning-only Planner is assigned');
    });
});

describe('built-in role display aliases', () => {
    const ALIASES = { planner: 'Architect', project_lead: 'Crew Lead', worker: 'Builder', delegate: 'Helper', reviewer: 'QA Gate' } as const;

    it('saves, reads and clears an alias per built-in while preserving every unrelated field', () => {
        const existing = {
            v: 1 as const,
            instructionsByRole: { reviewer: 'Keep.' },
            colorsByRole: { reviewer: '#112233' },
            displayNamesByRole: { worker: 'Builder', futureRole: 'Future alias' },
            futureTop: { keep: true },
        };
        const named = setBuiltInSessionRoleDisplayNameV1(existing, 'reviewer', '  QA Gate  ');
        expect(named).toEqual({ ...existing, displayNamesByRole: { worker: 'Builder', futureRole: 'Future alias', reviewer: 'QA Gate' } });
        expect(readBuiltInSessionRoleDisplayNameV1(named, 'reviewer')).toBe('QA Gate');
        expect(readBuiltInSessionRoleDisplayNameV1(named, 'planner')).toBeNull();
        expect(readBuiltInSessionRoleDisplayNameV1(named, createCustomSessionRoleIdV1('123e4567-e89b-12d3-a456-426614174000'))).toBeNull();

        const blanked = setBuiltInSessionRoleDisplayNameV1(named, 'reviewer', '   ');
        expect(blanked.displayNamesByRole).toEqual({ worker: 'Builder', futureRole: 'Future alias' });
        const onlyWorker = setBuiltInSessionRoleDisplayNameV1({ v: 1, instructionsByRole: {}, displayNamesByRole: { worker: 'Builder' } }, 'worker', null);
        expect(onlyWorker).toEqual({ v: 1, instructionsByRole: {} });
        expect(DEFAULT_SESSION_ROLE_PROFILES_V1).toEqual({ v: 1, instructionsByRole: {} });
    });

    it('lists the alias beside the canonical built-in name, and none for custom roles', () => {
        const id = createCustomSessionRoleIdV1('123e4567-e89b-12d3-a456-426614174000');
        const profiles = addCustomSessionRoleProfileV1(
            setBuiltInSessionRoleDisplayNameV1(undefined, 'reviewer', 'QA Gate'),
            { id, name: 'Architect', instructions: 'Design.', color: '#123456' },
        );
        const listed = listAssignableSessionRoleProfilesV1({ sessionRoleProfilesV1: profiles });
        expect(listed.map(({ id: roleId, name, displayName }) => ({ roleId, name, displayName }))).toEqual([
            { roleId: 'planner', name: 'Planner', displayName: null },
            { roleId: 'project_lead', name: 'Project Manager', displayName: null },
            { roleId: 'worker', name: 'Worker', displayName: null },
            { roleId: 'reviewer', name: 'Reviewer', displayName: 'QA Gate' },
            { roleId: id, name: 'Architect', displayName: null },
        ]);
    });

    it('reads a malformed alias as absent without discarding the rest of the profiles', () => {
        const settings = {
            sessionRoleProfilesV1: {
                v: 1,
                instructionsByRole: { reviewer: 'Account reviewer rules.' },
                colorsByRole: { reviewer: '#112233' },
                displayNamesByRole: { reviewer: '   ', worker: 42 },
            },
        };
        expect(resolveAssignableSessionRoleProfileV1(settings, 'reviewer')).toMatchObject({
            instructions: 'Account reviewer rules.',
            color: '#112233',
            displayName: null,
        });
        expect(readBuiltInSessionRoleDisplayNameV1(settings.sessionRoleProfilesV1, 'worker')).toBeNull();
    });

    it('never reaches agent-facing names: assignment snapshots, session prompts, run roles and messages stay canonical', () => {
        let profiles: unknown = undefined;
        for (const [role, alias] of Object.entries(ALIASES)) {
            profiles = setBuiltInSessionRoleDisplayNameV1(profiles, role as keyof typeof ALIASES, alias);
        }
        const settings = { sessionRoleProfilesV1: profiles };
        for (const role of SESSION_ROLES) {
            const alias = ALIASES[role];
            const canonical = { planner: 'Planner', project_lead: 'Project Manager', worker: 'Worker', reviewer: 'Reviewer' }[role];
            const plan = planSessionRoleChangeV1({ role, settings, changeId: `alias-${role}`, at: 1 });
            expect(plan?.assignment).not.toHaveProperty('name');
            expect(plan?.message.startsWith(`Role assignment: ${canonical}\n\n`)).toBe(true);
            expect(plan?.message).not.toContain(alias);

            const prompt = buildSessionRolePromptBlockTextV1({ sessionRoleV1: plan?.assignment });
            expect(prompt?.startsWith(`Current role assignment: ${canonical}\n\n`)).toBe(true);
            expect(prompt).not.toContain(alias);

            // The visible-run launch role takes `name` from this profile (executionRuns.ts launchRole).
            const profile = resolveAssignableSessionRoleProfileV1(settings, role)!;
            expect(profile).toMatchObject({ name: canonical, displayName: alias });
            const runPrompt = buildExecutionRunRolePromptBlockTextV1({ id: role, name: profile.name, instructions: profile.instructions });
            expect(runPrompt.startsWith(`Current run role: ${canonical}\n\n`)).toBe(true);
            expect(runPrompt).not.toContain(alias);
        }
    });
});
