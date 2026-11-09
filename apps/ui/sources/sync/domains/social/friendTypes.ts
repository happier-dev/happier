import type { RelationshipStatus } from '@happier-dev/protocol/social/friends';

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
} from '@happier-dev/protocol/social/friends';

//
// Utility functions
//

export function isFriend(status: RelationshipStatus): boolean {
    return status === 'friend';
}

export function isPendingRequest(status: RelationshipStatus): boolean {
    return status === 'pending';
}

export function isRequested(status: RelationshipStatus): boolean {
    return status === 'requested';
}
