-- The signed receipt transition is the only writer of native cleanup proof.
ALTER TABLE "Deployment" ADD COLUMN "teardownProof" JSONB;
