group "default" {
  targets = ["website", "webapp", "docs", "server"]
}

target "website" {
  dockerfile = "docker/Dockerfile"
  target     = "website"
  tags       = ["happier-website:local"]
}

target "webapp" {
  dockerfile = "docker/Dockerfile"
  target     = "webapp"
  tags       = ["happier-webapp:local"]
}

target "docs" {
  dockerfile = "docker/Dockerfile"
  target     = "docs"
  tags       = ["happier-docs:local"]
}

target "server" {
  dockerfile = "docker/Dockerfile"
  target     = "server"
  tags       = ["happier-server:local"]
}

