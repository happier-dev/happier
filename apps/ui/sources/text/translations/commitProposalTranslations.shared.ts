

export type Count = { count: number };



export type CommitProposalCopy = typeof en;



export const en = {
    title: ({ count }: Count) => (count === 1 ? 'One commit for your pending changes' : `${count} commits for your pending changes`),
    titlePhone: ({ count }: Count) => (count === 1 ? 'One commit' : `${count} commits`),
    proposedBy: ({ who, committed, total }: { who: string; committed: number; total: number }) => `Proposed by ${who} · ${committed} of ${total} files · ordered so each commit builds on the last.`,
    proposedByPhone: ({ committed, total }: { committed: number; total: number }) => `${committed} of ${total} pending files · tap a change to move it.`,
    moveHint: ({ max }: { max: number }) => `Move any change with ⌥1–${max} or its menu.`,
    modelFallback: 'the model',
    regenerate: 'Regenerate',
    conflict: 'The proposal changed elsewhere. This is the latest; make your change again.',
    approvalPending: 'Waiting for approval to create these commits.',
    discardBody: 'The proposal is removed. Your pending changes stay as they are.', askFix: ({ hook, number, message }: { hook: string; number: number; message: string }) => `The ${hook} hook stopped commit ${number}, “${message}”. Please fix what it reports so the commit can go through:`, askFixGeneric: ({ number, message }: { number: number; message: string }) => `A hook stopped commit ${number}, “${message}”. Please fix what it reports so the commit can go through:`, discarded: 'Proposal discarded.', undo: 'Undo',
    fileCount: ({ count }: Count) => (count === 1 ? '1 file' : `${count} files`),
    part: ({ count, of }: { count: number; of: number }) => `${count} of ${of} changes`,
    move: {
        a11y: ({ file }: { file: string }) => `Move ${file} to another commit`,
        title: ({ file }: { file: string }) => `Move ${file} to`,
        newCommitAfter: ({ number }: { number: number }) => `New commit after ${number}`,
        newCommitMessage: ({ file }: { file: string }) => `Update ${file}`,
        leaveOut: 'Leave out of these commits',
        leaveOutHint: 'Stays in your working tree',
    },
    group: {
        a11y: ({ number, message }: { number: number; message: string }) => `Commit ${number}: ${message}`,
        editMessage: 'Edit message',
        messageA11y: ({ number }: { number: number }) => `Message of commit ${number}`,
        more: 'More',
        moveUp: 'Move up',
        moveDown: 'Move down',
        mergeWithNext: 'Merge with the next commit',
        empty: 'No changes yet. Move one here, or merge it into the next commit.',
    },
    leftOut: {
        title: 'Left out · stays in your working tree',
        description: 'These changes stay pending. Commit them on their own if you meant to.',
    },
    footer: {
        commits: ({ count }: Count) => (count === 1 ? '1 commit' : `${count} commits`),
        onBranch: ({ branch }: { branch: string }) => ` on ${branch} · hooks and signing run as they do for any commit`,
        detached: ' on a detached HEAD · hooks and signing run as they do for any commit',
        phone: 'Hooks and signing run as usual',
        discard: 'Discard proposal',
        create: ({ count }: Count) => (count === 1 ? 'Create 1 commit' : `Create ${count} commits`),
        createShort: ({ count }: Count) => `Create ${count}`,
        emptyGroupReason: 'A commit has no changes. Move one into it, or merge it away.',
    },
    applying: {
        title: ({ count }: Count) => (count === 1 ? 'Creating 1 commit' : `Creating ${count} commits`),
        body: 'One at a time through the normal commit path, so your hooks and signing run as usual. Editing pauses until this finishes.',
        bodyPhone: 'Editing pauses until this finishes.',
        created: ({ landed, total }: { landed: number; total: number }) => `${landed} of ${total}`,
        createdRest: ' created · nothing is rolled back if a later one stops',
        createdRestPhone: ' created',
        stopAfterThis: 'Stop after this commit',
        stopAfterThisShort: 'Stop after this',
        stopping: 'Stopping after this commit',
    },
    state: {
        waiting: 'Waiting',
        writing: 'Running hooks and creating the commit',
        landed: 'committed', landedAt: ({ time }: { time: string }) => `committed ${time}`, signed: 'signed', pausedBy: ({ hook, count }: { hook: string; count: number }) => (count === 1 ? `${hook} changed 1 file · not committed yet` : `${hook} changed ${count} files · not committed yet`), hookFailedBy: ({ hook }: { hook: string }) => `${hook} failed · not committed`,
        rewritten: 'a hook rewrote the message',
        notCreated: 'Not created · still yours to edit',
        notCreatedShort: 'Not created',
        unknown: 'Not confirmed yet',
        paused: ({ count }: Count) => (count === 1 ? 'A hook changed 1 file · not committed yet' : `A hook changed ${count} files · not committed yet`),
        failed: 'Stopped here · not committed',
    },
    outcome: {
        signingTitle: 'Your commits can’t be signed right now.',
        signingBody: 'This repository signs every commit. Nothing has been committed.',
        signingHint: 'Unlock your GPG or SSH agent first',
        tryAgain: 'Try again',
        cancel: 'Cancel',
        hookChanged: ({ files }: { files: string }) => `The hook changed ${files}.`,
        waitsAfterLanded: ({ count }: Count) => (count === 1 ? 'Commit 1 landed; this one waits for you.' : `${count} commits landed; this one waits for you.`),
        waits: 'This one waits for you.',
        include: 'Include the hook’s changes',
        includePhone: 'Include and commit',
        cancelCommit: 'Cancel this commit',
        hookFailed: 'A hook stopped this commit.', hookChangedBy: ({ hook, files }: { hook: string; files: string }) => `${hook} changed ${files}.`, hookFailedBy: ({ hook }: { hook: string }) => `${hook} stopped this commit.`,
        hookFailedBody: 'Earlier commits stay. The rest are still yours to edit.',
        headMoved: ({ branch }: { branch: string }) => `${branch} moved while committing.`,
        headMovedBody: 'The next commit was refused, and nothing was rolled back.',
        proposeAgain: 'Propose again for what’s left',
        keepEditing: 'Keep editing', askSessionToFix: 'Ask this session to fix it', showInGit: 'Show in Git',
        unknownTitle: 'We couldn’t confirm whether this commit landed.',
        unknownBody: 'Nothing is retried until we know. Check again to read the branch.',
        checkAgain: 'Check again',
        stoppedTitle: ({ landed, total }: { landed: number; total: number }) => `${landed} of ${total} commits created`,
        stoppedBody: ({ count }: Count) => (count === 1
            ? 'The last one wasn’t created. Its changes are still in your working tree, as before.'
            : `${count} weren’t created. Their changes are still in your working tree, as before.`),
        createRest: ({ count }: Count) => (count === 1 ? 'Create the last one' : `Create the remaining ${count}`),
        completeTitle: ({ count }: Count) => (count === 1 ? '1 commit created' : `${count} commits created`),
        completeBody: 'Nothing was pushed.',
        onBranch: ({ branch }: { branch: string }) => `on ${branch}`,
        failed: {
            staging_conflict: 'Something else changed what’s staged.',
            selection_conflict: 'These changes can’t be split this way.',
            source_changed: 'The pending changes moved since this was proposed.',
            writer_failed: 'The commit couldn’t be created.',
            publication_warning: 'The commit landed, but the staged files weren’t updated.',
            cancelled: 'This commit was cancelled.',
        },
        failedBody: 'Earlier commits stay. Nothing was rolled back.',
    },
    none: {
        title: 'No commit proposal yet',
        reason: 'A proposal groups your pending changes into commits you can edit, then creates them one at a time through the normal commit path.',
        propose: 'Propose commits',
        writing: 'Grouping your pending changes…',
    },
    gitPane: {
        title: 'Proposed commits',
        meta: ({ count, files }: { count: number; files: number }) => `${count} · ${files} files`,
        inCommit: ({ count, number }: { count: number; number: number }) => `${count} in commit ${number}`,
        open: 'Open',
        review: 'Review',
        reviewInWalkthrough: 'Review in walkthrough',
        more: 'Discard or regenerate',
        selectedHint: 'Selected. Tap again to open it in Commits',
        tapHint: 'Tap to show its changes',
    },
};


export const commitProposalTranslationsEnglish: Pick<Readonly<Record<'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant', { commitProposal: CommitProposalCopy }>>, "en"> = { en: { commitProposal: en } };