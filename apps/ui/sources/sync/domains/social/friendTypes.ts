import type { RelationshipStatus, UserProfile } from '@happier-dev/protocol';

export {
    RelationshipStatusSchema,
    type RelationshipStatus,
    UserProfileSchema,
    type UserProfile,
    UserResponseSchema,
    type UserResponse,
    FriendsResponseSchema,
    type FriendsResponse,
    UsersSearchResponseSchema,
    type UsersSearchResponse,
    RelationshipUpdatedEventSchema,
    type RelationshipUpdatedEvent,
} from '@happier-dev/protocol';

//
// Utility functions
//

export function getDisplayName(profile: UserProfile): string {
    const fullName = [profile.firstName, profile.lastName].filter(Boolean).join(' ');
    return fullName || profile.username;
}

export function isFriend(status: RelationshipStatus): boolean {
    return status === 'friend';
}

export function isPendingRequest(status: RelationshipStatus): boolean {
    return status === 'pending';
}

export function isRequested(status: RelationshipStatus): boolean {
    return status === 'requested';
}
