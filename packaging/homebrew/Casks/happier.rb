cask "happier" do
  arch arm: "aarch64", intel: "x86_64"

  version "0.2.12"
  sha256 arm:   "b9536e3244b30c891b4310bdcf892738682a84ad3f1afee00b9e64a9146eb509",
         intel: "cc85a7d049a0d52fcd11d310d65310349a8535477789021303ea034a110451a9"

  url "https://github.com/happier-dev/happier/releases/download/ui-desktop-v#{version}/happier-ui-desktop-darwin-#{arch}-v#{version}.dmg"
  name "Happier"
  desc "Cross-device client for coding agents"
  homepage "https://happier.dev/"

  livecheck do
    url "https://github.com/happier-dev/happier/releases/download/ui-desktop-stable/latest.json"
    strategy :json do |json|
      json["version"]
    end
  end

  # The app updates itself from the same stable feed. This keeps a plain `brew upgrade` from
  # replacing it; `brew upgrade --greedy` (or `--greedy-auto-updates`) still upgrades it.
  auto_updates true
  depends_on macos: :ventura

  app "Happier.app"

  uninstall quit: "dev.happier.app"

  # ~/.happier is deliberately absent: it is the Happier CLI's home (account, machine and
  # daemon state) and is shared with any CLI installed on this computer.
  zap trash: [
    "~/Library/Caches/dev.happier.app",
    "~/Library/HTTPStorages/dev.happier.app",
    "~/Library/LaunchAgents/Happier.plist",
    "~/Library/Preferences/dev.happier.app.plist",
    "~/Library/Saved Application State/dev.happier.app.savedState",
    "~/Library/WebKit/dev.happier.app",
  ]
end
