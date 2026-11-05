/** Shared declaration; Software binds the existing daemon username target fact. */
export function createDockerMembershipStep<T extends string | { kind: 'targetFact'; fact: 'daemon.username' }>(daemonUsername: T): {
    id: 'docker-membership'; kind: 'group'; name: 'docker'; members: T[];
    review: { title: string; description: string };
} {
    return { id: 'docker-membership', kind: 'group', name: 'docker', members: [daemonUsername],
        review: { title: 'Docker administrator access',
            description: 'Docker group membership gives the Happier daemon root-equivalent administrator power. Happier must restart to pick up new membership. On supported Linux installations, Software Apply restarts Happier after the operation completes.' } };
}
