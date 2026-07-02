CREATE TABLE "review_comments" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "workspace_id" TEXT,
    "session_id" TEXT,
    "run_id" TEXT,
    "engine_id" TEXT,
    "finding_id" TEXT,
    "thread_id" TEXT NOT NULL,
    "parent_comment_id" TEXT,
    "state" TEXT NOT NULL,
    "flags_json" TEXT NOT NULL,
    "anchor_json" TEXT NOT NULL,
    "anchor_file_path" TEXT,
    "anchor_folder_path" TEXT,
    "snapshot_envelope_json" TEXT NOT NULL,
    "body_envelope_json" TEXT NOT NULL,
    "body_version" INTEGER NOT NULL,
    "author_json" TEXT NOT NULL,
    "edits_json" TEXT NOT NULL,
    "dispositions_json" TEXT NOT NULL,
    "evidence_json" TEXT,
    "transitions_json" TEXT NOT NULL,
    "fingerprint_json" TEXT,
    "linked_refs_json" TEXT,
    "suggested_fix_json" TEXT,
    "metadata_json" TEXT,
    "tombstone_json" TEXT,
    "server_revision" INTEGER NOT NULL,
    "created_at" BIGINT NOT NULL,
    "updated_at" BIGINT NOT NULL,

    CONSTRAINT "review_comments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "review_comment_events" (
    "event_id" TEXT NOT NULL,
    "comment_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "event_kind" TEXT NOT NULL,
    "event_envelope_json" TEXT NOT NULL,
    "bulk_action_id" TEXT,
    "client_mutation_id" TEXT,
    "actor_json" TEXT NOT NULL,
    "author_device_id" TEXT,
    "client_lamport" BIGINT,
    "server_revision" INTEGER NOT NULL,
    "created_at" BIGINT NOT NULL,

    CONSTRAINT "review_comment_events_pkey" PRIMARY KEY ("event_id")
);

CREATE INDEX "review_comments_project_state_idx"
ON "review_comments"("project_id", "state", "updated_at");

CREATE INDEX "review_comments_project_run_idx"
ON "review_comments"("project_id", "run_id", "updated_at");

CREATE INDEX "review_comments_project_engine_idx"
ON "review_comments"("project_id", "engine_id", "updated_at");

CREATE INDEX "review_comments_project_file_idx"
ON "review_comments"("project_id", "anchor_file_path", "updated_at");

CREATE INDEX "review_comment_events_comment_idx"
ON "review_comment_events"("comment_id", "server_revision");

CREATE INDEX "review_comment_events_account_project_idx"
ON "review_comment_events"("account_id", "project_id", "created_at");

ALTER TABLE "review_comments" ADD CONSTRAINT "review_comments_account_id_fkey"
FOREIGN KEY ("account_id") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "review_comment_events" ADD CONSTRAINT "review_comment_events_account_id_fkey"
FOREIGN KEY ("account_id") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "review_comment_events" ADD CONSTRAINT "review_comment_events_comment_id_fkey"
FOREIGN KEY ("comment_id") REFERENCES "review_comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
